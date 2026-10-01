"""Read the comment annotations in HTML files and write them to standard output as a JSON array.

A tool for checking comments without opening the editor. Comments live only in the HTML, so the script
keeps no separate record and reads the files every time it is called. Input files are only read, never modified.

Usage:
    python scripts/list_comments.py [--status all|unresolved|resolved] file.html [...]
"""

import argparse
import json
import re
import sys
from html import unescape
from html.parser import HTMLParser
from pathlib import Path

# The statuses that can be specified. The first one applies when none is given.
_STATUSES = ('all', 'unresolved', 'resolved')

_BODY_TAG_NAME = 'body'
_COMMENT_TAG_NAME = 'comment'

# Entry element names mapped to the `kind` in the result.
_ENTRY_KINDS = {'comment-body': 'body', 'comment-reply': 'reply'}

# Elements without an end tag. Counting them as open elements would make the entries that follow them
# no longer direct children of the comment.
_VOID_TAG_NAMES = frozenset({
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
})

# Elements whose content the editor reads as text. Reading the tags, HTML comments and quotation marks inside
# them as markup would make a document the editor opens look as if it had no `<body>`, or several.
# Which elements `HTMLParser` reads as text varies by version: some versions do not switch for `title` and
# `textarea`, and some also switch for `xmp` and `plaintext`. So when reading the body as well, the switch
# happens for these four only, the same way on every version.
_RAW_TEXT_TAG_NAMES = frozenset({'script', 'style', 'textarea', 'title'})

# For each raw text element, the start of the end tag that ends its content. The editor ends the content where
# `</` and the element name are followed by whitespace, `/` or `>`.
# Case is ignored for ASCII letters only. Without `re.ASCII`, `ſ` (U+017F) and `ı` (U+0131) would also match
# `s` and `i`, ending the content at `</ſcript>`, which the editor does not read as the end.
_RAW_TEXT_END_PATTERNS = {
    name: re.compile(rf'</{name}(?=[\t\n\f\r />])', re.IGNORECASE | re.ASCII) for name in _RAW_TEXT_TAG_NAMES
}

# The raw text elements whose character references are expanded. The editor shows `&amp;` inside these two as `&`.
_ESCAPABLE_RAW_TEXT_TAG_NAMES = frozenset({'textarea', 'title'})

# The start and end of an HTML comment. The editor skips from the start to the first end after it, and no other
# spelling closes the comment.
_HTML_COMMENT_OPENING = '<!--'
_HTML_COMMENT_CLOSING = '-->'

# The run of characters the editor reads as a tag name. Unlike the HTML specification, it allows a leading digit
# and ends the name at any non-alphanumeric character (`<1` is a tag, and `<body-x>` is `body`). When `<` or `</`
# is not followed by such a run, the editor does not read it as a tag.
_TAG_NAME = re.compile(r'[a-zA-Z0-9]+')

# The name of an end tag: it starts with a letter and runs up to whitespace, `/` or `>`. This matches both
# `HTMLParser` and the end tag names of the HTML specification.
_END_TAG_NAME = re.compile(r'[a-zA-Z][^\t\n\r\f />\x00]*')

# The characters the HTML specification treats as whitespace inside a tag, and the characters that end
# an attribute name or an unquoted value.
_TAG_WHITESPACE = '\t\n\f\r '
_ATTRIBUTE_NAME_END = '\t\n\f\r />='
_UNQUOTED_VALUE_END = '\t\n\f\r >'

# Code points collapsed into a single space when the annotated text is turned into one line.
# The set matches `\s` in browser regular expressions so that the text agrees with what the editor shows
# in the comment outline.
_WHITESPACE_TO_SPACE = dict.fromkeys(
    (
        0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x00A0, 0x1680,
        *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
    ),
    ' ',
)


class _OpenElement:
    """One open element in the body."""

    def __init__(self, tag, comment=None, entry=None):
        self.tag = tag
        # The comment record, if this is a `comment` element.
        self.comment = comment
        # The entry record, if this is an entry directly under a comment.
        self.entry = entry
        # The text collected for the annotated text or the entry until the element closes.
        self.parts = []


class _CommentCollector(HTMLParser):
    """Read the body and collect the comments in the order of their start tags.

    Markup is delimited the same way as in the body boundary scan, and spellings that `HTMLParser` reads
    differently across versions are read the same way on every version.
    """

    def __init__(self, file_name):
        super().__init__(convert_charrefs=True)
        self.comments = []
        self._file_name = file_name
        self._open_elements = []

    def close(self):
        """Read the remaining text and close any unclosed elements at the end of the body."""
        super().close()
        if self.cdata_elem is not None and self.rawdata:
            # Older versions of `HTMLParser` discard the rest of unclosed raw text instead of passing it on as text.
            # The browser reads everything up to the end of the body as that element's text, so pass it on for
            # every version. Newer versions have already passed it on inside `close()`, so nothing remains here.
            self.handle_data(self.rawdata)
            self.rawdata = ''
        # The end of the body is where the `<body>` end tag is. Elements whose end tag was left out close here too.
        self._close_elements(0)

    def set_cdata_mode(self, elem, **kwargs):
        """Switch to reading the content as text, only for elements whose content the editor reads as text.

        The end of the content is found by the same rules as the editor.
        """
        if elem not in _RAW_TEXT_TAG_NAMES:
            return
        # If `HTMLParser` decided whether to expand character references in the content, some versions would not.
        # Keep every version from expanding them and expand them in `handle_data` instead.
        super().set_cdata_mode(elem)
        # Older versions of `HTMLParser` look for the end only in the form `</script>`, missing `</script x>` and
        # ending at `</ script>`, so replace the search with the one the body boundary scan uses.
        self.interesting = _RAW_TEXT_END_PATTERNS[self.cdata_elem]

    def parse_endtag(self, i):
        """Read the end of raw text and a `</` not followed by an alphanumeric character by the editor's rules.

        For an end tag whose name starts with a letter, find where the tag ends here. A name starting with a digit
        is left to `HTMLParser`, because every version reads it the same way.
        """
        if self.cdata_elem is None or not self.interesting.match(self.rawdata, i):
            if not _TAG_NAME.match(self.rawdata, i + len('</')):
                # Depending on the version, `HTMLParser` reads `</ x>` as an end tag or skips up to the next `>`.
                # As in the body boundary scan, read `<` as text and continue after it.
                self.handle_data('<')
                return i + 1
            name = _END_TAG_NAME.match(self.rawdata, i + len('</'))
            if name is None:
                return super().parse_endtag(i)
            # Older versions of `HTMLParser` also close an end tag at a `>` inside quotation marks, so find
            # the end here.
            tag_end = _find_end_tag_end(self.rawdata, name.end())
            if tag_end < 0:
                # For a tag not closed by `>`, the browser discards everything up to the end of the body as part of
                # the tag. The text after it is not read.
                return len(self.rawdata)
            self.handle_endtag(name.group().lower())
            return tag_end
        tag_end = _find_tag_end(self.rawdata, i + len('</') + len(self.cdata_elem))
        if tag_end < 0:
            # The editor does not treat an end tag without a closing `>` as a tag, and reads what follows as
            # outside the raw text.
            self.clear_cdata_mode()
            self.handle_data('<')
            return i + 1
        # Older versions of `HTMLParser` cannot read `</script x>` as an end tag, so close the element here.
        tag = self.cdata_elem
        self.clear_cdata_mode()
        self.handle_endtag(tag)
        return tag_end

    def parse_comment(self, i, report=True):
        """Read from `<!--` to the first `-->` after it as an HTML comment.

        Depending on the version, `HTMLParser` also closes it at `--!>` or `-- >`, and closes a `<!-->` with no `-->`
        after it as an empty comment. Leaving the closing to `HTMLParser` would make whether the comment annotations
        written inside are read depend on the version, so close it the same way as the body boundary scan.
        """
        closing = self.rawdata.find(_HTML_COMMENT_CLOSING, i + len(_HTML_COMMENT_OPENING))
        if closing < 0:
            # The comment is unclosed, so it runs to the end of the body. Returning -1 to leave it to `HTMLParser`
            # would make older versions read up to the next `>` as text and what follows as tags. The whole body is
            # fed before reading, so read the comment to the end here.
            if report:
                self.handle_comment(self.rawdata[i + len(_HTML_COMMENT_OPENING):])
            return len(self.rawdata)
        if report:
            self.handle_comment(self.rawdata[i + len(_HTML_COMMENT_OPENING):closing])
        return closing + len(_HTML_COMMENT_CLOSING)

    def parse_html_declaration(self, i):
        """Read a `<!` other than `<!--` as a text `<` and advance one character, as the body boundary scan does.

        `HTMLParser` reads `<!DOCTYPE` and bogus comments as a unit up to the next `>`, and on some versions
        `<![CDATA[` up to `]]>`, without returning the comment annotations written inside. Delimit them the same
        way as the body boundary scan so that they read the same on every version.
        """
        self.handle_data('<')
        return i + 1

    def parse_pi(self, i):
        """Read a `<?` as a text `<` and advance one character, as the body boundary scan does.

        `HTMLParser` reads up to the next `>` as a processing instruction and does not return the comment
        annotations written inside.
        """
        self.handle_data('<')
        return i + 1

    def handle_starttag(self, tag, attrs):
        if tag in _RAW_TEXT_TAG_NAMES:
            # Some versions of `HTMLParser` do not switch by themselves for `title` and `textarea`, so switch here
            # for every such element. On versions that do switch, the same switch simply comes once more afterwards.
            self.set_cdata_mode(tag)
        if tag == _BODY_TAG_NAME:
            # This appears only inside spellings that the body boundary scan did not read as tags (such as
            # `<1 <body>`). Skip it, as the browser does.
            return
        if tag in _VOID_TAG_NAMES:
            if tag == 'br':
                # In the one-line text, a line break reads as a word break. It is not added to the entry text.
                self._append_text(' ', to_entries=False)
            return

        attributes = _to_attribute_map(attrs)
        comment = None
        entry = None
        if tag == _COMMENT_TAG_NAME:
            comment = {
                'file': self._file_name,
                'id': attributes.get('id', ''),
                # Whether a comment is resolved depends only on whether the attribute is present. Its value is
                # ignored, even `false`.
                'resolved': 'data-resolved' in attributes,
                'target': '',
                'entries': [],
            }
            self.comments.append(comment)
        elif tag in _ENTRY_KINDS:
            parent = self._open_elements[-1] if self._open_elements else None
            # An entry written inside another entry or inside another element does not count toward the
            # comment's thread.
            if parent is not None and parent.comment is not None:
                entry = {
                    'kind': _ENTRY_KINDS[tag],
                    'text': '',
                    'author': attributes.get('data-author', ''),
                    'updated': attributes.get('data-updated', ''),
                }
                parent.comment['entries'].append(entry)
        self._open_elements.append(_OpenElement(tag, comment, entry))

    def handle_startendtag(self, tag, attrs):
        """Read a start tag closed with `/>` as a start tag only, as the editor and the HTML specification do.

        By default, `HTMLParser` also passes it on as an end tag, which would close `<comment/>` on the spot.
        """
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        for index in range(len(self._open_elements) - 1, -1, -1):
            if self._open_elements[index].tag == tag:
                # Elements whose end tag was left out close together with the end tag of an outer element.
                self._close_elements(index)
                return
        # An end tag without a matching start tag is skipped without closing anything.

    def handle_data(self, data):
        if self.cdata_elem in _ESCAPABLE_RAW_TEXT_TAG_NAMES:
            data = unescape(data)
        self._append_text(data, to_entries=True)

    def _append_text(self, text, *, to_entries):
        """Add text to the annotated text of the open comments and to the open entries."""
        inside_entry = False
        for element in reversed(self._open_elements):
            if element.tag in _ENTRY_KINDS:
                # For the comments outside this point, the text is inside an entry and is not annotated text.
                inside_entry = True
                if to_entries and element.entry is not None:
                    element.parts.append(text)
            elif element.comment is not None and not inside_entry:
                element.parts.append(text)

    def _close_elements(self, index):
        """Close the element at `index` and the elements inside it, moving the collected text into the records."""
        for element in self._open_elements[index:]:
            if element.comment is not None:
                element.comment['target'] = _collapse_whitespace(''.join(element.parts))
            elif element.entry is not None:
                element.entry['text'] = ''.join(element.parts)
        del self._open_elements[index:]


def _collect_body_tags(text):
    """Collect the document's `<body>` start and end tags by the scan the editor uses to find the body boundary.

    The scan skips HTML comments and the content of raw text elements, and skips each tag as a whole, so that
    a `<body>` written inside them or in an attribute value is not counted.

    Returns:
        A pair of the start tags and the end tags. Each tag is a pair of the position of its `<` and the position
        right after the tag.
    """
    start_tags = []
    end_tags = []
    index = text.find('<')
    while index >= 0:
        if text.startswith(_HTML_COMMENT_OPENING, index):
            closing = text.find(_HTML_COMMENT_CLOSING, index + len(_HTML_COMMENT_OPENING))
            if closing < 0:
                # An unclosed HTML comment runs to the end of the document.
                break
            index = text.find('<', closing + len(_HTML_COMMENT_CLOSING))
            continue
        tag = _parse_tag(text, index)
        if tag is None:
            # A `<` that cannot be read as a tag is text; continue from the next character.
            index = text.find('<', index + 1)
            continue
        name, is_end_tag, end = tag
        if name == _BODY_TAG_NAME:
            (end_tags if is_end_tag else start_tags).append((index, end))
        if not is_end_tag and name in _RAW_TEXT_TAG_NAMES:
            # Skip the content and read the end tag that ends it as a tag on the next iteration. Without an end tag,
            # the content runs to the end of the document.
            content_end = _RAW_TEXT_END_PATTERNS[name].search(text, end)
            index = content_end.start() if content_end else -1
        else:
            index = text.find('<', end)
    return start_tags, end_tags


def _parse_tag(text, start):
    """Read one tag from the `<` at `start` by the rules the editor uses to find the body boundary.

    These rules differ from the HTML specification, but so that the script opens the same documents the editor
    opens, the tag name is a run of `_TAG_NAME`, and the end of the tag is found by skipping `>` inside quotation
    marks.

    Returns:
        A tuple of the lowercase tag name, whether it is an end tag, and the position right after the tag.
        None if there is no name or the tag is not closed by `>`.
    """
    index = start + 1
    is_end_tag = text.startswith('/', index)
    if is_end_tag:
        index += 1
    name = _TAG_NAME.match(text, index)
    if name is None:
        return None
    end = _find_tag_end(text, name.end())
    if end < 0:
        return None
    return name.group().lower(), is_end_tag, end


def _find_tag_end(text, index):
    """Find the `>` that closes a tag, starting at `index` and skipping `>` inside quotation marks.

    Returns the position right after it, or -1 if there is none. This reads tags the same way the editor does
    when finding the body boundary.
    """
    quote = ''
    for position in range(index, len(text)):
        character = text[position]
        if quote:
            if character == quote:
                quote = ''
        elif character in ('"', "'"):
            quote = character
        elif character == '>':
            return position + 1
    return -1


def _find_end_tag_end(text, index):
    """Find the `>` that closes an end tag as the HTML specification does, starting at `index` right after its name.

    Returns the position right after it, or -1 if there is none. A quotation mark encloses a value only when it
    comes right after `=`, and a `>` inside it does not close the tag. A quotation mark in the middle of a name or
    inside an unquoted value is just a character. `_find_tag_end` copies the editor's body boundary scan, which
    takes a value to start wherever a quotation mark appears, so it is not used for end tags in the body that
    the browser reads.
    """
    length = len(text)
    while index < length:
        character = text[index]
        if character == '>':
            return index + 1
        if character == '/' or character in _TAG_WHITESPACE:
            index += 1
            continue
        # An attribute name. A leading `=` is part of the name, which runs up to the next `=`, whitespace, `/` or `>`.
        index += 1
        while index < length and text[index] not in _ATTRIBUTE_NAME_END:
            index += 1
        value_start = index
        while value_start < length and text[value_start] in _TAG_WHITESPACE:
            value_start += 1
        if value_start >= length or text[value_start] != '=':
            continue
        value_start += 1
        while value_start < length and text[value_start] in _TAG_WHITESPACE:
            value_start += 1
        if value_start < length and text[value_start] in ('"', "'"):
            closing = text.find(text[value_start], value_start + 1)
            if closing < 0:
                return -1
            index = closing + 1
        else:
            # An unquoted value runs up to whitespace or `>`.
            index = value_start
            while index < length and text[index] not in _UNQUOTED_VALUE_END:
                index += 1
    return -1


def _to_attribute_map(attrs):
    """Map the attributes of a start tag from name to value.

    An attribute without a value maps to an empty string. When a name appears more than once, the first value is kept.
    """
    attributes = {}
    for name, value in attrs:
        # Under the HTML specification, only the first attribute with a given name takes effect. Later values do not
        # overwrite it, so that the values match what the editor reads.
        attributes.setdefault(name, value or '')
    return attributes


def _collapse_whitespace(text):
    """Collapse runs of whitespace into a single space and strip whitespace from both ends."""
    return ' '.join(part for part in text.translate(_WHITESPACE_TO_SPACE).split(' ') if part)


def extract_comments(file_name: str, html: str) -> list[dict]:
    """Return the comments inside the HTML `<body>` in the document order of their start tags.

    Comments without an ID, comments without entries and nested comments are returned as they are, as far as
    they can be read. The list shows what is written; correcting it would make it disagree with the HTML.

    Args:
        file_name: The name to put in `file` of the results. The file is not opened.
        html: The text of the whole document.

    Returns:
        A list of comment records (`file`, `id`, `resolved`, `target`, `entries`), one per comment.
        An empty list if there are no comments.

    Raises:
        ValueError: The `<body>` start tag and end tag do not appear exactly once each, in that order.
    """
    # `HTMLParser` reads tag names and quotation marks differently from the editor, and differently across versions,
    # so it is not used to decide the body boundary. Cut out the body with the same scan as the editor and pass only
    # the body to `HTMLParser`.
    start_tags, end_tags = _collect_body_tags(html)
    if len(start_tags) != 1 or len(end_tags) != 1 or end_tags[0][0] < start_tags[0][1]:
        # The editor opens only documents of this shape. For any other shape, where the inside of `<body>` lies
        # would have to be guessed.
        raise ValueError(
            f'{file_name}: expected exactly one <body> start tag followed by exactly one </body> end tag'
            f' (found {len(start_tags)} start tags and {len(end_tags)} end tags)'
        )
    collector = _CommentCollector(file_name)
    collector.feed(html[start_tags[0][1]:end_tags[0][0]])
    collector.close()
    return collector.comments


def read_comments_from_files(paths) -> list[dict]:
    """Read the given files in turn and return their comments, in the given file order and then in document order.

    If any file cannot be read, nothing is returned, not even the results of the files read before it. A partial
    list would mislead the reader into thinking they had seen every comment.

    Args:
        paths: The paths of the HTML files.

    Returns:
        A list of the comment records of all the files.

    Raises:
        OSError: A file cannot be read.
        ValueError: A file cannot be decoded as UTF-8, or its `<body>` start tag and end tag do not appear exactly
            once each, in that order.
    """
    comments = []
    for path in paths:
        try:
            # Reading with the OS default encoding would give different results for the same file depending on
            # the environment. A BOM is accepted.
            html = Path(path).read_text(encoding='utf-8-sig')
        except UnicodeDecodeError as error:
            raise ValueError(
                f'{path}: cannot be decoded as UTF-8. The input must be HTML encoded in UTF-8 (with or without a BOM)'
            ) from error
        except OSError as error:
            raise OSError(f'{path}: cannot read the file ({error.strerror or error})') from error
        comments.extend(extract_comments(str(path), html))
    return comments


def filter_comments(comments: list[dict], status: str) -> list[dict]:
    """Filter comments by status, keeping their order.

    Args:
        comments: A list of comment records.
        status: One of `all`, `unresolved` and `resolved`.

    Returns:
        A list of the comments that match the status.

    Raises:
        ValueError: The status is none of the three.
    """
    if status not in _STATUSES:
        raise ValueError(f'unknown status: {status} (choose from {", ".join(_STATUSES)})')
    if status == 'all':
        return list(comments)
    return [comment for comment in comments if comment['resolved'] == (status == 'resolved')]


def main(argv: list[str] | None = None) -> int:
    """Read the command-line arguments and write the matching comments to standard output as a JSON array.

    Args:
        argv: The arguments without the command name. Defaults to the arguments of the process.

    Returns:
        The exit code: 0 on success and 1 on failure.
    """
    # The default output encoding depends on the OS and environment variables, and some settings cannot write
    # Japanese. Fix it to UTF-8.
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser(
        description='List the comment annotations in HTML files as a JSON array on standard output.'
        ' The files are never modified.',
        epilog='Exits with 0 on success and 1 on failure. On failure, the reason is written to standard error'
        ' and no JSON is written.',
    )
    parser.add_argument(
        '--status',
        choices=_STATUSES,
        default=_STATUSES[0],
        help='resolution status of the comments to return (default: all)',
    )
    parser.add_argument('files', nargs='+', metavar='file.html', help='HTML files to read (UTF-8)')
    try:
        arguments = parser.parse_args(argv)
    except SystemExit as exit_request:
        # argparse exits with code 2 on argument errors. Use a single exit code for every failure.
        return 0 if exit_request.code in (0, None) else 1

    try:
        comments = filter_comments(read_comments_from_files(arguments.files), arguments.status)
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1

    # Write everything at once after reading it all, so that a failure partway through leaves no partial output.
    sys.stdout.write(json.dumps(comments, ensure_ascii=False, indent=2) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
