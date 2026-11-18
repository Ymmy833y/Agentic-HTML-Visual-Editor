"""Append a reply from the agent to a comment annotation in an HTML file.

A tool for answering a comment without reading the whole document or editing its markup by hand. The reply becomes the
last entry of the comment, with `ai` as its author and the current time, and the comments are checked the same way as
by `check_comments.py`. Nothing else in the file changes, and a reply that would add an error is not written.

Usage:
    python scripts/add_reply.py --id c-a1b2c3d4 (--reply TEXT | --reply-file reply.html) file.html
"""

import argparse
import codecs
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

# Python puts the directory of the script on the module search path, except in isolated mode (`-I`). Put it there
# either way, so that the reader and the checks shared with the other scripts are found.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_comments  # noqa: E402
import list_comments  # noqa: E402

_REPLY_TAG_NAME = 'comment-reply'
_LINK_TAG_NAME = 'a'

# The headings. A browser closes the innermost open one at the end tag of any of them, whatever its level.
_HEADING_TAG_NAMES = frozenset({'h1', 'h2', 'h3', 'h4', 'h5', 'h6'})

# The tags that keep the editor from opening a document when one of them is anywhere in its body, even inside a
# `template`. The list matches the editor's, so that a reply never leaves the document unopenable.
_FORBIDDEN_TAG_NAMES = frozenset({'base', 'embed', 'iframe', 'link', 'meta', 'noscript', 'object', 'script', 'style'})

# The start tag of a forbidden tag: `<`, the name, and whitespace, `/` or `>`. The reply is searched as text, because
# the way `list_comments.py` reads it would miss some of them, for the reasons given for `_DIVERGENT_MARKUP`, and such
# a tag in an attribute value is refused too. Case is ignored as Unicode defines it, not for ASCII letters only: the
# editor compares tag names after `toLowerCase()`, which also turns the Kelvin sign (U+212A) into `k`. A few spellings
# that the editor accepts, such as one with the long s (U+017F) for `s`, are refused too, and no reply needs them.
_FORBIDDEN_START_TAG = re.compile(
    rf'<({"|".join(sorted(_FORBIDDEN_TAG_NAMES))})(?=[\t\n\f\r />])', re.IGNORECASE
)

# Markup that a browser reads differently from `list_comments.py`, whose way of reading a reply the checks below use,
# so that they could pass a reply that a browser reads as leaving an element open past its end. A browser also ends an
# HTML comment at `<!-->` or `--!>`, where the reader keeps it open up to `-->`, and reads any other `<!` or `<?`, and a
# `</` not followed by a letter, as a comment up to the next `>`, where the reader goes on reading the tags after it. It
# reads `title` and `textarea` inside `svg` and `math` as markup, and the content of `xmp`, `noembed`, `noframes` and
# `plaintext` as text. A reply has no use for any of them. As in a browser, case is ignored for ASCII letters only.
_DIVERGENT_MARKUP = re.compile(
    r'<!--|<[!?]|</(?![a-zA-Z])|<(?:math|noembed|noframes|plaintext|svg|xmp)(?=[\t\n\f\r />])',
    re.IGNORECASE | re.ASCII,
)

# The name of a start tag as a browser reads it: an ASCII letter and what follows it up to whitespace, `/` or `>`.
_START_TAG_NAME = re.compile(r'[a-zA-Z][^\t\n\f\r />]*')

# The characters the HTML specification treats as whitespace. They are dropped from both ends of the reply, so that
# the trailing line break of a file or an argument does not show as an empty line of the entry.
_HTML_WHITESPACE = '\t\n\f\r '

_LINE_BREAK = re.compile(r'\r\n|\r|\n')


class _CommentLocator(list_comments._CommentCollector):
    """Read the body like `list_comments.py`, apart from the end tags of headings, and note where the end tag of each
    comment starts and which comments are inside a link."""

    def __init__(self, file_name, body):
        super().__init__(file_name, body)
        # The position in the body of the `</comment>` that closes each comment record, keyed by the record's identity.
        # A comment closed only by the end of an outer element or of the body has no entry.
        self.end_tags = {}
        # The identities of the comment records inside a link with no `template` between the link and the comment.
        self.in_link = set()

    def handle_starttag(self, tag, attrs):
        super().handle_starttag(tag, attrs)
        if tag == list_comments._COMMENT_TAG_NAME:
            # The comment is now the innermost open element. A browser closes an open link, and the comment inside it,
            # at the start tag of another link, unless a `template` lies between the link and that start tag.
            for element in reversed(self._open_elements[:-1]):
                if element.tag == check_comments._TEMPLATE_TAG_NAME:
                    break
                if element.tag == _LINK_TAG_NAME:
                    self.in_link.add(id(self.comments[-1]))
                    break

    def handle_endtag(self, tag):
        if tag == list_comments._COMMENT_TAG_NAME:
            # The end tag closes the innermost open comment, as in `list_comments.py`.
            for element in reversed(self._open_elements):
                if element.tag == tag:
                    self.end_tags[id(element.comment)] = self.position()
                    break
        elif tag in _HEADING_TAG_NAMES:
            # A browser closes the innermost open heading at the end tag of a heading of any level, where
            # `list_comments.py` waits for the end tag of the same level. Read it as a browser does, so that reading
            # the document again finds a reply that closes the heading around the comment, and the comment with it.
            for element in reversed(self._open_elements):
                if element.tag in _HEADING_TAG_NAMES:
                    tag = element.tag
                    break
        super().handle_endtag(tag)


class _ReplyReader(list_comments._CommentCollector):
    """Read the content of a reply on its own, and note the elements that it does not close with their own end tag, the
    start tags that do not end inside it or that `HTMLParser` ends elsewhere than a browser or reads as text, and its
    links."""

    def __init__(self, content):
        super().__init__('', content)
        # Each element that the reply does not close with its own end tag, as a pair of its name and whether a
        # `template` encloses it, in the order they close.
        self.unclosed = []
        # The name of the first start tag that does not end inside the reply as a browser reads it, or None.
        self.start_tag_left_open = None
        # The name of the first start tag that `HTMLParser` ends at a different `>` from a browser or reads as text,
        # or None.
        self.start_tag_misread = None
        # Whether the reply holds the start tag of a link outside a `template`.
        self.has_link = False

    def parse_starttag(self, i):
        # A browser reads a quoted attribute value up to the same quotation mark, wherever that is, so a tag whose value
        # the reply does not close takes in what follows the reply. `HTMLParser` can end such a tag at a `>` inside the
        # value instead, as when whitespace surrounds the `=` before it, so find the end as the HTML specification does.
        name = _START_TAG_NAME.match(self.rawdata, i + 1)
        tag_end = list_comments._find_end_tag_end(self.rawdata, name.end())
        if self.start_tag_left_open is None and tag_end < 0:
            self.start_tag_left_open = name.group().lower()
        end = super().parse_starttag(i)
        # Versions of `HTMLParser` from before it read attributes by the HTML specification also take more than one `=`,
        # or whitespace that a browser does not count, such as U+3000, around `=` as part of the value indicator. They
        # can then end a tag at a different `>` from a browser, or take the tag as unfinished when a quotation mark that
        # the reply leaves open comes after it and read the tag as text. The checks below would then miss what lies in
        # between, or the element that a browser opens with the tag.
        if self.start_tag_misread is None and tag_end >= 0 and end != tag_end:
            self.start_tag_misread = name.group().lower()
        return end

    def handle_starttag(self, tag, attrs):
        if tag == _LINK_TAG_NAME and all(
            element.tag != check_comments._TEMPLATE_TAG_NAME for element in self._open_elements
        ):
            self.has_link = True
        super().handle_starttag(tag, attrs)

    def _close_elements(self, index, end):
        # An end tag closes its own element, at `index`, and with it the elements inside, which have no end tag of
        # their own. The end of the text closes every element still open. An end tag starts before the end of the
        # text, so `end` tells the two apart.
        first = index if end == len(self._body) else index + 1
        for position in range(first, len(self._open_elements)):
            in_template = any(
                element.tag == check_comments._TEMPLATE_TAG_NAME for element in self._open_elements[:position]
            )
            self.unclosed.append((self._open_elements[position].tag, in_template))
        super()._close_elements(index, end)


def _find_element_left_open(reader):
    """Return the name of the first element that a reply leaves open and the checks do not report, or None.

    A reply leaves an element open when it does not close the element with its own end tag, but with the end of the
    reply or with the end tag of an outer element. A browser keeps such an element open past the end of the entry: an
    open `template` takes in the rest of the document, and an inline element such as `code` is opened again around
    what follows the comment. A block is not counted, because the checks report a block outside a `template`. Nothing
    inside a `template` is counted either, because a browser carries nothing in a `template` past its end, and an open
    `template` is counted itself.

    Args:
        reader: A `_ReplyReader` that has read the whole reply.
    """
    for tag, in_template in reader.unclosed:
        if not in_template and tag not in check_comments._BLOCK_TAG_NAMES:
            return tag
    return None


def _detect_line_ending(text):
    """Return the line ending that prevails in the text: CRLF when it outnumbers the other line breaks, LF otherwise.

    This is how the editor decides the line ending it writes back to the file, so a reply follows the same choice.
    """
    crlf_count = 0
    other_count = 0
    for line_break in _LINE_BREAK.finditer(text):
        if line_break.group() == '\r\n':
            crlf_count += 1
        else:
            other_count += 1
    return '\r\n' if crlf_count > other_count else '\n'


def _format_time(time):
    """Write a time as the editor writes `data-updated`: ISO 8601 in UTC with milliseconds and a trailing `Z`."""
    utc = time.astimezone(timezone.utc)
    return f'{utc.strftime("%Y-%m-%dT%H:%M:%S")}.{utc.microsecond // 1000:03d}Z'


def _finding_key(finding):
    """Identify a finding without its line, which moves for every finding after a reply that spans lines."""
    return finding['id'], finding['level'], finding['rule'], finding['message']


def _added_findings(before, after):
    """Return the findings in `after` that `before` does not have, keeping their order."""
    remaining = Counter(_finding_key(finding) for finding in before)
    added = []
    for finding in after:
        key = _finding_key(finding)
        if remaining[key]:
            remaining[key] -= 1
        else:
            added.append(finding)
    return added


def append_reply(file_name: str, html: str, comment_id: str, reply: str, now: datetime) -> tuple[str, list[dict]]:
    """Return the document with a reply from the agent appended to a comment, and the problems the reply adds.

    The reply goes right before the `</comment>` end tag, after the last entry of the comment. Only problems that the
    document did not have before count, so that problems elsewhere, which the agent did not cause, do not stop a reply.

    Args:
        file_name: The name to put in error messages and in `file` of the findings. The file is not opened.
        html: The text of the whole document, with the line endings as they are in the file.
        comment_id: The `id` of the comment to answer.
        reply: The content of the reply: text and inline markup, or one `template` that holds blocks.
        now: The time to write as `data-updated`, with a time zone.

    Returns:
        A pair of the new text of the document and the findings of `check_comments.py` that the reply adds, with
        their lines in the new text. An empty list when the reply adds none.

    Raises:
        ValueError: The `<body>` start tag and end tag do not appear exactly once each, in that order, no comment or
            more than one comment has the ID, the comment has no end tag, or the reply is empty, holds a forbidden tag
            or markup that a browser reads differently from `list_comments.py`, leaves a start tag without its end,
            holds a start tag that `HTMLParser` ends elsewhere than a browser or reads as text, leaves a `template` or
            an inline element open, holds a link while the comment is inside one, keeps the comment from ending right
            after it, does not read back as written, or holds a `<body>` start tag or end tag.
    """
    content = reply.strip(_HTML_WHITESPACE)
    if not content:
        raise ValueError(f'{file_name}: the reply to {comment_id} is empty')

    start, end = list_comments.locate_body(file_name, html)
    body = html[start:end]
    locator = _CommentLocator(file_name, body)
    locator.feed(body)
    locator.close()
    matches = [comment for comment in locator.comments if comment['id'] == comment_id]
    if not matches:
        raise ValueError(f'{file_name}: no comment has the ID {comment_id}')
    if len(matches) > 1:
        # Choosing one of them would be a guess, and the reply could land in a thread the agent never read.
        raise ValueError(f'{file_name}: {len(matches)} comments have the ID {comment_id}')
    end_tag = locator.end_tags.get(id(matches[0]))
    if end_tag is None:
        raise ValueError(
            f'{file_name}: the comment {comment_id} has no </comment> end tag, so where its entries end is unclear'
        )
    forbidden = _FORBIDDEN_START_TAG.search(content)
    if forbidden is not None:
        # The checks look only at the markup of the comments, and see no problem in such a tag.
        raise ValueError(
            f'{file_name}: the reply to {comment_id} holds <{forbidden.group(1).lower()}>, a tag forbidden in the body,'
            ' so the editor would not open the document. Write each "<" of the text as &lt;'
        )
    divergent = _DIVERGENT_MARKUP.search(content)
    if divergent is not None:
        # The checks below read the reply as `list_comments.py` does, so they cannot tell where a browser ends it.
        raise ValueError(
            f'{file_name}: the reply to {comment_id} holds "{divergent.group()}", markup that a browser can read as'
            ' reaching beyond the reply. Write each "<" of the text as &lt;, and leave out HTML comments and svg,'
            ' math, xmp, noembed, noframes and plaintext elements'
        )
    reply_reader = _ReplyReader(content)
    reply_reader.feed(content)
    reply_reader.close()
    if reply_reader.start_tag_left_open is not None:
        raise ValueError(
            f'{file_name}: the reply to {comment_id} leaves the start tag <{reply_reader.start_tag_left_open}> without'
            ' its end, so a browser would read what follows the reply as part of the tag. A tag that ">" does not'
            ' close, or a quotation mark in it that the reply does not close, does this. Close each tag with ">" and'
            ' each quotation mark that the reply opens, and write each "<" of the text as &lt;'
        )
    if reply_reader.start_tag_misread is not None:
        raise ValueError(
            f'{file_name}: the reply to {comment_id} holds the start tag <{reply_reader.start_tag_misread}>, which this'
            ' version of Python ends at a different ">" from a browser or reads as text, so how a browser reads the'
            ' reply from that tag on cannot be checked. More than one "=", or whitespace other than a space, a tab or a'
            ' line break around "=", does this. Write each attribute as name="value", and write each "<" of the text'
            ' as &lt;'
        )
    left_open = _find_element_left_open(reply_reader)
    if left_open is not None:
        raise ValueError(
            f'{file_name}: the reply to {comment_id} leaves <{left_open}> open, so the document after the comment'
            ' would be read as part of that element. Close each element that the reply opens, and write each "<" of'
            ' the text as &lt;'
        )
    if reply_reader.has_link and id(matches[0]) in locator.in_link:
        # The checks below read a link inside a link as nested, where a browser closes the outer one.
        raise ValueError(
            f'{file_name}: the comment {comment_id} is inside a link, and a browser closes that link, and the comment'
            ' with it, at the start tag of a link in the reply. Write the link as text, or put the content of the'
            ' reply in a template as a paragraph'
        )

    written = _LINE_BREAK.sub(_detect_line_ending(html), content)
    entry = (
        f'<{_REPLY_TAG_NAME} contenteditable="false" data-author="{list_comments._AGENT_AUTHOR}"'
        f' data-updated="{_format_time(now)}">{written}</{_REPLY_TAG_NAME}>'
    )
    position = start + end_tag
    updated = html[:position] + entry + html[position:]

    # Markup in the reply can move where the comment or the reply ends, and the checks see no problem in either. Read
    # the comment again and make sure that it still ends right after the reply, and that its last entry is the reply as
    # written. Comments before it are unchanged, so it keeps its place in document order.
    index = next(index for index, comment in enumerate(locator.comments) if comment is matches[0])
    updated_body = updated[start:end + len(entry)]
    reread = _CommentLocator(file_name, updated_body)
    reread.feed(updated_body)
    reread.close()
    comment = reread.comments[index]
    if reread.end_tags.get(id(comment)) != end_tag + len(entry):
        # A browser shows what follows an early end tag in the document body, and takes the text after the reply into
        # a quotation mark that the reply leaves open.
        raise ValueError(
            f'{file_name}: the comment {comment_id} would no longer end right after the reply. An end tag in the reply,'
            ' such as </comment>, the </p> of the paragraph around the comment, or the end tag of a heading of any'
            ' level when the comment is in a heading, would close it early, or a quotation mark that the reply leaves'
            ' open would take in the text after it. Write each "<" of the text as &lt;, and close each quotation mark'
            ' that the reply opens'
        )
    if not comment['entries'] or comment['entries'][-1]['html'] != written:
        # A start tag at the end of the reply that `>` does not close takes in the end tag of the reply, and a
        # `</comment-reply>` in the reply ends it early. Either way a browser shows only part of the reply, and the
        # element of such a start tag can also take in the document after the comment.
        raise ValueError(
            f'{file_name}: the reply to {comment_id} would not read back as written. A tag at its end that ">" does not'
            ' close, or a </comment-reply> in it, would end the reply somewhere else. Close each tag with ">", and'
            ' write each "<" of the text as &lt;'
        )

    before = check_comments.check_comments(file_name, html, now)
    try:
        after = check_comments.check_comments(file_name, updated, now)
    except ValueError as error:
        # The document had one `<body>` before the reply, so the tag that breaks it is in the reply. The reason from
        # the checks would name the file as the one at fault.
        raise ValueError(
            f'{file_name}: the reply to {comment_id} holds a <body> start tag or end tag, so the document would no'
            ' longer have exactly one of each. Write each "<" of the text as &lt;'
        ) from error
    return updated, _added_findings(before, after)


def _read_document(path):
    """Read an HTML file as UTF-8 and return its text, with the line endings as they are, and whether it has a BOM.

    The text is not read in text mode, which would turn CRLF into LF and drop the BOM when the file is written back.

    Raises:
        OSError: The file cannot be read.
        ValueError: The file cannot be decoded as UTF-8.
    """
    try:
        data = Path(path).read_bytes()
    except OSError as error:
        raise OSError(f'{path}: cannot read the file ({error.strerror or error})') from error
    has_bom = data.startswith(codecs.BOM_UTF8)
    try:
        return data[len(codecs.BOM_UTF8) if has_bom else 0:].decode('utf-8'), has_bom
    except UnicodeDecodeError as error:
        raise ValueError(
            f'{path}: cannot be decoded as UTF-8. The input must be HTML encoded in UTF-8 (with or without a BOM)'
        ) from error


def _write_document(path, text, has_bom):
    """Write the text back as UTF-8, with the BOM if the file had one."""
    try:
        Path(path).write_bytes((codecs.BOM_UTF8 if has_bom else b'') + text.encode('utf-8'))
    except OSError as error:
        raise OSError(f'{path}: cannot write the file ({error.strerror or error})') from error


def main(argv: list[str] | None = None) -> int:
    """Read the command-line arguments, append the reply, and write the problems it adds as a JSON array.

    Args:
        argv: The arguments without the command name. Defaults to the arguments of the process.

    Returns:
        The exit code: 0 when the reply was written, and 1 when it was not.
    """
    # The default output encoding depends on the OS and environment variables. Fix it to UTF-8.
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser(
        description='Append a reply from ai to a comment annotation in an HTML file, and list the problems that the'
        ' reply adds to the markup of the comments as a JSON array on standard output.',
        epilog='Exits with 0 when the reply was written (warnings alone still give 0) and 1 otherwise. A reply that'
        ' adds an error is not written. When the arguments or the files cannot be used, the reason is written to'
        ' standard error and no JSON is written.',
    )
    parser.add_argument('--id', required=True, metavar='c-xxxxxxxx', help='ID of the comment to answer')
    content = parser.add_mutually_exclusive_group(required=True)
    content.add_argument('--reply', metavar='TEXT', help='content of the reply')
    content.add_argument(
        '--reply-file',
        metavar='reply.html',
        help='UTF-8 file that holds the content of the reply, for a shell that cannot pass it as an argument',
    )
    parser.add_argument('file', metavar='file.html', help='HTML file to add the reply to (UTF-8)')
    try:
        arguments = parser.parse_args(argv)
    except SystemExit as exit_request:
        # argparse exits with code 2 on argument errors. Use a single exit code for every failure.
        return 0 if exit_request.code in (0, None) else 1

    try:
        if arguments.reply is not None:
            reply = arguments.reply
        else:
            reply = list_comments.read_html_file(arguments.reply_file)
        html, has_bom = _read_document(arguments.file)
        updated, findings = append_reply(arguments.file, html, arguments.id, reply, datetime.now(timezone.utc))
        has_error = any(finding['level'] == 'error' for finding in findings)
        if not has_error:
            _write_document(arguments.file, updated, has_bom)
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1

    sys.stdout.write(json.dumps(findings, ensure_ascii=False, indent=2) + '\n')
    return 1 if has_error else 0


if __name__ == '__main__':
    sys.exit(main())
