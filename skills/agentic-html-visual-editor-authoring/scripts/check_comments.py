"""Check the markup of the comment annotations in HTML files and write the problems to standard output as a JSON array.

Only the comments are checked, not the rest of the document. The document is read the same way as by
`list_comments.py`, whose reader this script builds on. Input files are only read, never modified.

Usage:
    python scripts/check_comments.py file.html [...]
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from html import unescape
from pathlib import Path

# Python puts the directory of the script on the module search path, except in isolated mode (`-I`). Put it there
# either way, so that the reader shared with `list_comments.py` is found.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import list_comments  # noqa: E402

# The form of a comment ID: `c-` followed by 8 lowercase letters or digits.
_COMMENT_ID = re.compile(r'c-[a-z0-9]{8}')

# The form of `data-updated`: ISO 8601 in UTC with milliseconds and a trailing `Z`.
_UPDATED = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z')
_UPDATED_FORMAT = '%Y-%m-%dT%H:%M:%S.%fZ'

_AUTHORS = ('ai', 'human')
_EDITABLE_VALUE = 'false'
_TEMPLATE_TAG_NAME = 'template'

# Block elements. A comment sits inside a paragraph, and the browser ends that paragraph at the first of these written
# directly inside it, which tears the comment apart when the document is opened again.
_BLOCK_TAG_NAMES = frozenset({
    'address', 'article', 'aside', 'blockquote', 'caption', 'col', 'colgroup', 'dd', 'details', 'dialog', 'div', 'dl',
    'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
    'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
    'thead', 'tr', 'ul',
})

# An entry without a `template` at or beyond either size is reported as long: it may read better as a list, a table,
# or another block. The values are a rough guide, so the finding is a warning.
_LONG_PLAIN_LINES = 3
_LONG_PLAIN_CHARACTERS = 150

# The characters that count as whitespace beside a `template`, as in the HTML specification.
_HTML_WHITESPACE = '\t\n\f\r '

_TAG = re.compile(r'<[^>]*>')


class _CommentChecker(list_comments._CommentCollector):
    """Read the body like `list_comments.py` and collect the problems in the markup of its comments."""

    def __init__(self, file_name, body, first_line, now):
        """
        Args:
            file_name: The name to put in `file` of the findings.
            body: The text inside `<body>`.
            first_line: The line of the file on which the body starts.
            now: The time that `data-updated` must not be later than.
        """
        super().__init__(file_name, body)
        self.findings = []
        self._first_line = first_line
        self._now = now
        # How many start tags in the body carry each ID, and the comments that carry one, with their lines.
        self._id_counts = {}
        self._comment_ids = []

    def close(self):
        super().close()
        for comment_id, line in self._comment_ids:
            if self._id_counts[comment_id] > 1:
                self._report(
                    line, comment_id, 'error', 'id-duplicate',
                    f'another element in the body also has the ID {comment_id}',
                )
        self.findings.sort(key=lambda finding: finding['line'])

    def handle_starttag(self, tag, attrs):
        line = self._line()
        attributes = list_comments._to_attribute_map(attrs)
        if 'id' in attributes:
            self._id_counts[attributes['id']] = self._id_counts.get(attributes['id'], 0) + 1
        parent = self._open_elements[-1] if self._open_elements else None
        place, owner, in_template, in_block = self._place()
        # The comment the markup belongs to: the one whose annotated text it is in, or whose entry it is in.
        owner_id = owner.comment['id'] if place == 'target' else self._enclosing_comment_id()

        if tag == list_comments._COMMENT_TAG_NAME:
            self._check_comment(line, attributes.get('id', ''), place)
        elif tag in list_comments._ENTRY_KINDS and parent is not None and parent.comment is not None:
            self._check_entry(line, parent, tag, attributes)
        elif tag == _TEMPLATE_TAG_NAME:
            if parent is None or parent.entry is None:
                self._report(line, owner_id, 'error', 'template-misuse', 'a template is used outside a comment entry')
            else:
                parent.template_count += 1
                if parent.template_count == 2:
                    self._report(line, owner_id, 'error', 'template-misuse', 'an entry has more than one template')
        # A block inside a reported block is part of the same problem, so only the outermost one is reported.
        if tag in _BLOCK_TAG_NAMES and not in_block:
            if place == 'target':
                self._report(line, owner_id, 'error', 'block-in-target', f'the annotated text contains a <{tag}> block')
            elif place == 'entry' and not in_template:
                self._report(
                    line, owner_id, 'error', 'block-outside-template',
                    f'an entry contains a <{tag}> block outside a template',
                )

        if parent is not None:
            if parent.entry is not None and tag != _TEMPLATE_TAG_NAME:
                parent.other_content = True
            if parent.comment is not None and tag not in list_comments._ENTRY_KINDS:
                self._check_target_after_entries(line, parent)

        depth = len(self._open_elements)
        super().handle_starttag(tag, attrs)
        if len(self._open_elements) > depth:
            element = self._open_elements[-1]
            element.line = line
            element.template_count = 0
            element.other_content = False
            element.entry_tags = []
            element.target_after_entries = False

    def handle_data(self, data):
        if self._open_elements and data.strip(_HTML_WHITESPACE):
            parent = self._open_elements[-1]
            if parent.entry is not None:
                parent.other_content = True
            elif parent.comment is not None:
                self._check_target_after_entries(self._line(), parent)
        super().handle_data(data)

    def _close_elements(self, index, end):
        for element in self._open_elements[index:]:
            if element.entry is None:
                continue
            comment_id = self._enclosing_comment_id(element)
            if element.template_count and element.other_content:
                self._report(
                    element.line, comment_id, 'error', 'template-misuse',
                    'an entry has other content beside its template',
                )
            if not element.template_count:
                self._check_length(element.line, comment_id, self._body[element.content_start:end])
        super()._close_elements(index, end)

    def _check_comment(self, line, comment_id, place):
        if not comment_id:
            self._report(line, '', 'error', 'id-format', 'the comment has no ID')
        elif not _COMMENT_ID.fullmatch(comment_id):
            self._report(
                line, comment_id, 'error', 'id-format',
                f'the ID {comment_id} is not c- followed by 8 lowercase letters or digits',
            )
        if comment_id:
            self._comment_ids.append((comment_id, line))
        if place == 'target':
            self._report(
                line, comment_id, 'error', 'nested-comment',
                'the comment is inside the annotated text of another comment',
            )
        elif place == 'entry':
            self._report(
                line, comment_id, 'error', 'comment-in-entry', 'the comment is inside an entry of another comment',
            )

    def _check_entry(self, line, comment_element, tag, attributes):
        comment_id = comment_element.comment['id']
        kind = list_comments._ENTRY_KINDS[tag]
        if kind == 'body' and 'body' in comment_element.entry_tags:
            self._report(line, comment_id, 'error', 'entry-order', 'the comment has more than one body')
        elif kind == 'body' and 'reply' in comment_element.entry_tags:
            self._report(line, comment_id, 'error', 'entry-order', 'the body comes after a reply')
        comment_element.entry_tags.append(kind)

        author = attributes.get('data-author')
        if author not in _AUTHORS:
            self._report(
                line, comment_id, 'error', 'entry-attribute',
                f'data-author is {_describe(author)}, not ai or human',
            )
        updated = attributes.get('data-updated')
        updated_time = _parse_updated(updated)
        if updated_time is None:
            self._report(
                line, comment_id, 'error', 'entry-attribute',
                f'data-updated is {_describe(updated)}, not a UTC time such as 2026-01-15T09:30:00.000Z',
            )
        elif updated_time > self._now:
            self._report(line, comment_id, 'warning', 'future-updated', f'data-updated {updated} is later than now')
        editable = attributes.get('contenteditable')
        if editable != _EDITABLE_VALUE:
            self._report(
                line, comment_id, 'error', 'entry-attribute',
                f'contenteditable is {_describe(editable)}, not false',
            )

    def _check_target_after_entries(self, line, comment_element):
        """Report annotated text written after the entries of a comment, once per comment."""
        if comment_element.entry_tags and not comment_element.target_after_entries:
            comment_element.target_after_entries = True
            self._report(
                line, comment_element.comment['id'], 'error', 'entry-order',
                'annotated text comes after the entries of the comment',
            )

    def _check_length(self, line, comment_id, html):
        text = unescape(_TAG.sub('', html))
        lines = [part.strip() for part in text.split('\n') if part.strip()]
        characters = sum(len(part) for part in lines)
        if len(lines) >= _LONG_PLAIN_LINES or characters >= _LONG_PLAIN_CHARACTERS:
            self._report(
                line, comment_id, 'warning', 'long-plain-entry',
                f'an entry of {len(lines)} lines and {characters} characters has no blocks;'
                ' a list, a table, or an alert may read better',
            )

    def _place(self):
        """Tell where the markup being read is: in an entry, in the annotated text of a comment, or outside comments.

        Returns:
            A tuple of the place (`entry`, `target` or `outside`), the entry or comment element it belongs to,
            whether a `template` lies between that element and the markup, and whether a block does.
        """
        in_template = False
        in_block = False
        for element in reversed(self._open_elements):
            if element.tag == _TEMPLATE_TAG_NAME:
                in_template = True
            elif element.tag in list_comments._ENTRY_KINDS:
                return 'entry', element, in_template, in_block
            elif element.comment is not None:
                return 'target', element, in_template, in_block
            elif element.tag in _BLOCK_TAG_NAMES:
                in_block = True
        return 'outside', None, in_template, in_block

    def _enclosing_comment_id(self, element=None):
        """Return the ID of the innermost open comment around `element`, or around the markup being read."""
        elements = self._open_elements
        if element is not None:
            elements = elements[:elements.index(element)]
        for candidate in reversed(elements):
            if candidate.comment is not None:
                return candidate.comment['id']
        return ''

    def _line(self):
        return self._first_line + self.getpos()[0] - 1

    def _report(self, line, comment_id, level, rule, message):
        self.findings.append({
            'file': self._file_name,
            'line': line,
            'id': comment_id,
            'level': level,
            'rule': rule,
            'message': message,
        })


def _describe(value):
    return 'missing' if value is None else json.dumps(value, ensure_ascii=False)


def _parse_updated(value):
    """Return `data-updated` as a time, or None when it is not in the form the editor writes."""
    if value is None or not _UPDATED.fullmatch(value):
        return None
    try:
        return datetime.strptime(value, _UPDATED_FORMAT).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def check_comments(file_name: str, html: str, now: datetime) -> list[dict]:
    """Return the problems in the markup of the comments inside the HTML `<body>`, in order of their lines.

    Args:
        file_name: The name to put in `file` of the findings. The file is not opened.
        html: The text of the whole document.
        now: The time that `data-updated` must not be later than, with a time zone.

    Returns:
        A list of findings (`file`, `line`, `id`, `level`, `rule`, `message`). An empty list if there are none.

    Raises:
        ValueError: The `<body>` start tag and end tag do not appear exactly once each, in that order.
    """
    start, end = list_comments.locate_body(file_name, html)
    body = html[start:end]
    checker = _CommentChecker(file_name, body, html.count('\n', 0, start) + 1, now)
    checker.feed(body)
    checker.close()
    return checker.findings


def check_files(paths, now: datetime) -> list[dict]:
    """Check the given files in turn and return their findings, in the given file order.

    If any file cannot be read, nothing is returned, so that a partial result is not taken for a clean one.

    Raises:
        OSError: A file cannot be read.
        ValueError: A file cannot be decoded as UTF-8, or its `<body>` start tag and end tag do not appear exactly
            once each, in that order.
    """
    findings = []
    for path in paths:
        findings.extend(check_comments(str(path), list_comments.read_html_file(path), now))
    return findings


def main(argv: list[str] | None = None) -> int:
    """Read the command-line arguments and write the findings to standard output as a JSON array.

    Args:
        argv: The arguments without the command name. Defaults to the arguments of the process.

    Returns:
        The exit code: 0 when there is no error, and 1 when there is an error or a file cannot be checked.
    """
    # The default output encoding depends on the OS and environment variables. Fix it to UTF-8.
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser(
        description='Check the markup of the comment annotations in HTML files and list the problems as a JSON array'
        ' on standard output. The files are never modified.',
        epilog='Exits with 0 when there is no error (warnings alone still give 0) and 1 otherwise. When a file cannot'
        ' be checked, the reason is written to standard error and no JSON is written.',
    )
    parser.add_argument('files', nargs='+', metavar='file.html', help='HTML files to check (UTF-8)')
    try:
        arguments = parser.parse_args(argv)
    except SystemExit as exit_request:
        # argparse exits with code 2 on argument errors. Use a single exit code for every failure.
        return 0 if exit_request.code in (0, None) else 1

    try:
        findings = check_files(arguments.files, datetime.now(timezone.utc))
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1

    sys.stdout.write(json.dumps(findings, ensure_ascii=False, indent=2) + '\n')
    return 1 if any(finding['level'] == 'error' for finding in findings) else 0


if __name__ == '__main__':
    sys.exit(main())
