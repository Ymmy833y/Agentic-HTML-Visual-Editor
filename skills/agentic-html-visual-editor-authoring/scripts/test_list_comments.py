"""Tests for the comment listing script.

They run on the standard library alone. Run them with this directory as the start directory:
`python -m unittest discover -s <this directory>`.
"""

import contextlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

import list_comments

SCRIPT_PATH = Path(__file__).with_name('list_comments.py')

# A document with one unresolved comment and one resolved comment. The annotated text, bodies and replies are
# written in Japanese, as escapes. In English, the document reads "Design notes", then "Saving is done [every hour]."
# with the body "This is a guess from the current settings." and the reply "Make it every 30 minutes.", and then
# "[Decide how to handle conflicts]" with the body "The plan is to keep both (A & B)." Brackets mark the annotated text.
DOCUMENT = (
    '<!DOCTYPE html>\n'
    '<html lang="ja">\n'
    '<head>\n'
    '<meta charset="utf-8">\n'
    '<title>\u8a2d\u8a08\u30e1\u30e2</title>\n'
    '</head>\n'
    '<body>\n'
    '<h1>\u8a2d\u8a08\u30e1\u30e2</h1>\n'
    '<p>\u4fdd\u5b58\u306f<comment id="c-a1b2c3d4">1 \u6642\u9593\u3054\u3068'
    '<comment-body contenteditable="false" data-author="ai" data-updated="2026-01-15T09:30:00.000Z">'
    '\u73fe\u5728\u306e\u8a2d\u5b9a\u304b\u3089\u306e\u63a8\u6e2c\u3067\u3059\u3002</comment-body>'
    '<comment-reply contenteditable="false" data-author="human" data-updated="2026-01-15T10:02:41.512Z">'
    '30 \u5206\u3054\u3068\u306b\u3057\u3066\u304f\u3060\u3055\u3044\u3002</comment-reply></comment>\u306b\u884c\u3046\u3002</p>\n'
    '<p><comment id="c-e5f6g7h8" data-resolved="">\u7af6\u5408\u306e<strong>\u6271\u3044</strong><br>\u3092\u6c7a\u3081\u308b'
    '<comment-body contenteditable="false" data-author="human" data-updated="2026-01-16T01:00:00.000Z">'
    '\u4e21\u65b9\u3092\u6b8b\u3059\u65b9\u91dd\u3067\u3059\uff08A &amp; B\uff09\u3002</comment-body></comment></p>\n'
    '</body>\n'
    '</html>\n'
)

# Another document with a single comment.
SECOND_DOCUMENT = (
    '<html><body><p><comment id="c-second01">Another document'
    '<comment-body data-author="ai" data-updated="2026-02-01T00:00:00.000Z">This is the second file.</comment-body>'
    '</comment></p></body></html>\n'
)

# A document with comments that have no `data-resolved`, an empty value, the value `false` and no value written,
# in that order.
MIXED_DOCUMENT = (
    '<html><body>\n'
    '<p><comment id="c-open0001">Unresolved'
    '<comment-body data-author="human">Not decided yet.</comment-body></comment></p>\n'
    '<p><comment id="c-done0001" data-resolved="">Empty value'
    '<comment-body data-author="human">Decided.</comment-body></comment></p>\n'
    '<p><comment id="c-done0002" data-resolved="false">Value false'
    '<comment-body data-author="ai">Done.</comment-body></comment></p>\n'
    '<p><comment id="c-done0003" data-resolved>No value</comment></p>\n'
    '</body></html>\n'
)


def expected_document_comments(file):
    """The results that should be read from `DOCUMENT`, written down from the document without running the script."""
    return [
        {
            'file': file,
            'id': 'c-a1b2c3d4',
            'resolved': False,
            'target': '1 \u6642\u9593\u3054\u3068',
            'entries': [
                {
                    'kind': 'body',
                    'text': '\u73fe\u5728\u306e\u8a2d\u5b9a\u304b\u3089\u306e\u63a8\u6e2c\u3067\u3059\u3002',
                    'author': 'ai',
                    'updated': '2026-01-15T09:30:00.000Z',
                },
                {
                    'kind': 'reply',
                    'text': '30 \u5206\u3054\u3068\u306b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
                    'author': 'human',
                    'updated': '2026-01-15T10:02:41.512Z',
                },
            ],
        },
        {
            'file': file,
            'id': 'c-e5f6g7h8',
            'resolved': True,
            'target': '\u7af6\u5408\u306e\u6271\u3044 \u3092\u6c7a\u3081\u308b',
            'entries': [
                {
                    'kind': 'body',
                    'text': '\u4e21\u65b9\u3092\u6b8b\u3059\u65b9\u91dd\u3067\u3059\uff08A & B\uff09\u3002',
                    'author': 'human',
                    'updated': '2026-01-16T01:00:00.000Z',
                },
            ],
        },
    ]


def expected_second_document_comments(file):
    """The results that should be read from `SECOND_DOCUMENT`."""
    return [
        {
            'file': file,
            'id': 'c-second01',
            'resolved': False,
            'target': 'Another document',
            'entries': [
                {
                    'kind': 'body',
                    'text': 'This is the second file.',
                    'author': 'ai',
                    'updated': '2026-02-01T00:00:00.000Z',
                },
            ],
        },
    ]


def run_cli(*arguments):
    """Run the script in a child process and return the result, which holds the exit code and the output bytes.

    The default encoding of standard output is set to one other than UTF-8, so that any reliance on the default
    encoding stops with an error. If the script relied on the OS default, its Japanese output would break in some
    users' environments.
    """
    return subprocess.run(
        [
            sys.executable,
            '-X', 'warn_default_encoding',
            '-W', 'error::EncodingWarning',
            str(SCRIPT_PATH),
            *map(str, arguments),
        ],
        capture_output=True,
        check=False,
        env={**os.environ, 'PYTHONIOENCODING': 'cp1252'},
    )


class StartTagRecorder(HTMLParser):
    """A parser that only collects start tag names and text in the order they appear."""

    def __init__(self):
        super().__init__()
        self.start_tags = []
        self.data = []

    def handle_starttag(self, tag, attrs):
        self.start_tags.append(tag)

    def handle_data(self, data):
        self.data.append(data)


@contextlib.contextmanager
def old_html_parser():
    """Reproduce how older versions of `HTMLParser` read raw text elements.

    Older versions pass on the tags inside `title` and `textarea` as tags, look for the end of raw text only in the
    form `</name>`, and do not expand character references in raw text. They close an end tag at a `>` inside
    quotation marks, and discard the rest of unclosed raw text instead of passing it on as text. This lets the tests
    confirm, even on a newer version, that the script absorbs the differences between versions by itself.
    """
    original_parse_endtag = HTMLParser.parse_endtag
    original_close = HTMLParser.close
    # The plain `</name>` form, with a name starting with a letter, that older versions read as an end tag, and
    # how they read the name.
    plain_end_tag = re.compile(r'</\s*[a-zA-Z][-.a-zA-Z0-9:_]*\s*>')
    end_tag_name = re.compile(r'</([a-zA-Z][^\t\n\r\f />\x00]*)')

    def end_tag_pattern(name):
        return re.compile(rf'</\s*{re.escape(name)}\s*>', re.IGNORECASE)

    def set_cdata_mode(self, elem, **kwargs):
        self.cdata_elem = elem.lower()
        self.interesting = end_tag_pattern(self.cdata_elem)
        # Newer versions expand character references in raw text when this value is true. Older versions never
        # expand them.
        self._escapable = False

    def close(self):
        # Older versions do not pass on the rest of unclosed raw text as text, and finish with it left in `rawdata`.
        if self.cdata_elem is None:
            original_close(self)

    def parse_endtag(self, i):
        if self.cdata_elem is None:
            name = end_tag_name.match(self.rawdata, i)
            if name is None or plain_end_tag.match(self.rawdata, i):
                return original_parse_endtag(self, i)
            # Close an end tag whose name starts with a letter at the first `>`, ignoring quotation marks.
            end = self.rawdata.find('>', i + 1)
            if end < 0:
                return -1
            self.handle_endtag(name.group(1).lower())
            return end + 1
        match = end_tag_pattern(self.cdata_elem).match(self.rawdata, i)
        if match is None:
            # An end tag not in the form `</name>` does not close the raw text and is passed on as text.
            end = self.rawdata.find('>', i)
            if end < 0:
                return -1
            self.handle_data(self.rawdata[i:end + 1])
            return end + 1
        self.handle_endtag(self.cdata_elem)
        self.clear_cdata_mode()
        return match.end()

    with (
        mock.patch.object(HTMLParser, 'RCDATA_CONTENT_ELEMENTS', (), create=True),
        mock.patch.object(HTMLParser, 'set_cdata_mode', set_cdata_mode),
        mock.patch.object(HTMLParser, 'parse_endtag', parse_endtag),
        mock.patch.object(HTMLParser, 'close', close),
    ):
        yield


# A paragraph with a single comment, placed in the documents that check the body boundary. It uses no quotation
# marks, so that it does not disturb how the quotation marks in the document pair up.
COMMENTED_PARAGRAPH = '<p><comment id=c-00000011>target</comment></p>'


class ListCommentsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def write(self, name, content):
        """Write a file to the temporary directory and return its path.

        The content is written as bytes so that line endings are not converted.
        """
        path = self.directory / name
        path.write_bytes(content)
        return path

    def read_json(self, completed):
        """Read the standard output of a successful child process as UTF-8 JSON."""
        self.assertEqual(completed.returncode, 0, completed.stderr.decode('utf-8', 'replace'))
        return json.loads(completed.stdout.decode('utf-8'))

    def assert_old_html_parser(self):
        """Check that the older version is reproduced inside `old_html_parser`. Otherwise the cases check nothing."""
        recorder = StartTagRecorder()
        recorder.feed('<title><a></title><script></script x><b></script><style></ style><i>')
        recorder.close()
        self.assertEqual(
            recorder.start_tags,
            ['title', 'a', 'script', 'style', 'i'],
            'the older HTMLParser is not reproduced',
        )
        # Newer versions expand character references in raw text when the switch asks for expansion.
        recorder = StartTagRecorder()
        recorder.set_cdata_mode('textarea', escapable=True)
        recorder.feed('&amp;</textarea>')
        recorder.close()
        self.assertEqual(
            ''.join(recorder.data), '&amp;', 'the older version that does not expand raw text is not reproduced'
        )
        # Newer versions close an end tag at a `>` outside quotation marks and pass on the rest of unclosed raw text
        # as text.
        recorder = StartTagRecorder()
        recorder.feed('<p></p x=">">y')
        recorder.close()
        self.assertEqual(
            ''.join(recorder.data),
            '">y',
            'the older version that closes end tags at a `>` inside quotation marks is not reproduced',
        )
        recorder = StartTagRecorder()
        recorder.feed('<script>x')
        recorder.close()
        self.assertEqual(recorder.data, [], 'the older version that discards unclosed raw text is not reproduced')

    def assert_boundary_like_editor(self, documents):
        """Check that each document gives its comments if the editor opens it, and is an input error if not.

        The body boundary is decided without `HTMLParser`, but the comments of a document that opens are read with
        `HTMLParser`. So that the check fails on any version when the script does not absorb the differences between
        versions, it runs both with the local `HTMLParser` and with the reproduced older version.

        Args:
            documents: Tuples of a label, a document containing `COMMENTED_PARAGRAPH`, and whether the editor opens
                the document.
        """
        for parser_name, parser_context in (('this version', contextlib.nullcontext), ('older version', old_html_parser)):
            with parser_context():
                if parser_name == 'older version':
                    self.assert_old_html_parser()
                for label, document, opens in documents:
                    with self.subTest(parser=parser_name, document=label):
                        if opens:
                            comments = list_comments.extract_comments('boundary.html', document)
                            self.assertEqual([comment['id'] for comment in comments], ['c-00000011'])
                        else:
                            with self.assertRaises(ValueError):
                                list_comments.extract_comments('boundary.html', document)

    def assert_body_comment_ids(self, cases):
        """Check that every version of `HTMLParser` reads the same comments from each fragment placed in the body.

        The inside of the body is read with `HTMLParser`, so if the script did not absorb the differences between
        versions, the comments read would change on either the local version or the reproduced older version.

        Args:
            cases: Tuples of a label, a fragment to place in the body, and the IDs of the comments that should be
                read. `COMMENTED_PARAGRAPH` follows the fragment, so the IDs end with its ID.
        """
        for parser_name, parser_context in (('this version', contextlib.nullcontext), ('older version', old_html_parser)):
            with parser_context():
                if parser_name == 'older version':
                    self.assert_old_html_parser()
                for label, fragment, expected_ids in cases:
                    with self.subTest(parser=parser_name, body=label):
                        comments = list_comments.extract_comments(
                            'body.html', f'<html><body>{fragment}{COMMENTED_PARAGRAPH}</body></html>'
                        )
                        self.assertEqual([comment['id'] for comment in comments], expected_ids)

    def assert_body_targets(self, cases):
        """Check that every version of `HTMLParser` reads the same annotated text from each fragment in the body.

        This covers spellings where versions differ only in the text read, not in the number of comments. It runs
        both with the local version and with the reproduced older version.

        Args:
            cases: Tuples of a label, a fragment containing exactly one comment, and the text that should be read
                as the annotated text of that comment.
        """
        for parser_name, parser_context in (('this version', contextlib.nullcontext), ('older version', old_html_parser)):
            with parser_context():
                if parser_name == 'older version':
                    self.assert_old_html_parser()
                for label, fragment, expected_target in cases:
                    with self.subTest(parser=parser_name, body=label):
                        comments = list_comments.extract_comments('target.html', f'<html><body>{fragment}</body></html>')
                        self.assertEqual([comment['target'] for comment in comments], [expected_target])

    def test_extract_comments(self):
        """Return comments and the bodies and replies directly under them in written order, keeping Japanese as is."""
        with self.subTest('returns comments in document order, with each field as written'):
            self.assertEqual(
                list_comments.extract_comments('memo.html', DOCUMENT),
                expected_document_comments('memo.html'),
            )

        with self.subTest('comments from several files follow the order in which the files are given'):
            second = self.write('second.html', SECOND_DOCUMENT.encode('utf-8'))
            first = self.write('first.html', DOCUMENT.encode('utf-8'))
            self.assertEqual(
                list_comments.read_comments_from_files([second, first]),
                [*expected_second_document_comments(str(second)), *expected_document_comments(str(first))],
            )

        with self.subTest('a document without comments gives an empty result'):
            self.assertEqual(
                list_comments.extract_comments('plain.html', '<html><body><p>No comments</p></body></html>'),
                [],
            )

        with self.subTest('comments written outside `<body>` are not read'):
            self.assertEqual(
                list_comments.extract_comments(
                    'outside.html',
                    '<html><head><comment id="c-before01">before</comment></head><body><p>No comments</p></body>'
                    '<comment id="c-after001">after</comment></html>',
                ),
                [],
            )

        # A document with `<body>` and comments written as text inside `title` and `textarea`, and the results that
        # should be read from it.
        raw_text_document = (
            '<html><head><title><body> explained</title></head><body>'
            '<textarea><body></body><comment id="c-00000013">inside</comment></textarea>'
            '<p><comment id="c-00000005">target<comment-body>body</comment-body></comment></p></body></html>'
        )
        raw_text_comments = [
            {
                'file': 'raw-text.html',
                'id': 'c-00000005',
                'resolved': False,
                'target': 'target',
                'entries': [{'kind': 'body', 'text': 'body', 'author': '', 'updated': ''}],
            },
        ]

        with self.subTest(
            '`<body>` and comments written as text inside `title` and `textarea` count neither toward the body'
            ' boundary nor as comments'
        ):
            self.assertEqual(list_comments.extract_comments('raw-text.html', raw_text_document), raw_text_comments)

        with self.subTest(
            'comments written in a `textarea` in the body are not read, even by an `HTMLParser` that passes on'
            ' the tags inside as tags'
        ):
            # Newer versions of `HTMLParser` read the inside of `title` and `textarea` as text by themselves. To notice
            # if the script's own switch is removed, reproduce the older versions that pass on the tags inside, so that
            # the check holds on any version.
            with old_html_parser():
                self.assert_old_html_parser()
                self.assertEqual(
                    list_comments.extract_comments('raw-text.html', raw_text_document),
                    raw_text_comments,
                )

        with self.subTest(
            '`<body>` inside `xmp` and the like counts toward the body boundary and comments there are read, even'
            ' by an `HTMLParser` that reads their inside as text'
        ):
            # Newer versions of `HTMLParser` also read the inside of `xmp` and the like as text, but the editor counts
            # the tags inside and does not open the document.
            # Inside the body too, the script reads their inside as tags, as the body boundary scan does.
            # To check under the same conditions on older versions, the elements read as text are set to match newer
            # versions.
            cdata_elements = ('script', 'style', 'xmp', 'iframe', 'noembed', 'noframes')
            with mock.patch.object(HTMLParser, 'CDATA_CONTENT_ELEMENTS', cdata_elements):
                recorder = StartTagRecorder()
                recorder.feed('<xmp><body></xmp>')
                # If the newer version is not reproduced, this case does not check the code that prevents the switch.
                self.assertNotIn('body', recorder.start_tags, 'the HTMLParser that reads the inside as text is not reproduced')
                for tag in ('xmp', 'iframe', 'noembed', 'noframes'):
                    with self.subTest(tag=tag), self.assertRaises(ValueError):
                        list_comments.extract_comments(
                            f'{tag}.html',
                            f'<html><body><{tag}><body></{tag}><p><comment id="c-00000006">target</comment></p>'
                            '</body></html>',
                        )
                    with self.subTest(tag=tag, place='comment in the body'):
                        comments = list_comments.extract_comments(
                            f'{tag}.html',
                            f'<html><body><{tag}><comment id="c-00000014">inside</comment></{tag}>'
                            '<p><comment id="c-00000006">target</comment></p></body></html>',
                        )
                        self.assertEqual([comment['id'] for comment in comments], ['c-00000014', 'c-00000006'])

        with self.subTest('`</body>` after `plaintext` also counts toward the body boundary'):
            # Newer versions of `HTMLParser` read everything after `plaintext` as text, but the editor counts the end
            # tag after it and opens the document.
            self.assertEqual(
                list_comments.extract_comments(
                    'plaintext.html',
                    '<html><body><p><comment id="c-00000007">target<comment-body>body</comment-body></comment></p>'
                    '<plaintext>trailing text</body></html>',
                ),
                [
                    {
                        'file': 'plaintext.html',
                        'id': 'c-00000007',
                        'resolved': False,
                        'target': 'target',
                        'entries': [{'kind': 'body', 'text': 'body', 'author': '', 'updated': ''}],
                    },
                ],
            )

        with self.subTest('`<script>` and `<style>` written as text inside `title` and `textarea` are not tags either'):
            # After passing on a `script` or `style` start tag, `HTMLParser` tries to switch to reading the inside as
            # text. Allowing that inside `title` or `textarea` would turn everything after the closing tag into text,
            # and documents the editor opens could not be read.
            documents = {
                'title': '<html><head><title>The <{inner}> element</title></head><body>{content}</body></html>',
                'textarea': '<html><body><textarea>The <{inner}> element</textarea>{content}</body></html>',
            }
            content = '<p><comment id="c-00000008">target</comment></p>'
            for container, document in documents.items():
                for inner in ('script', 'style'):
                    with self.subTest(container=container, inner=inner):
                        self.assertEqual(
                            list_comments.extract_comments(
                                'raw-text-script.html',
                                document.format(inner=inner, content=content),
                            ),
                            [
                                {
                                    'file': 'raw-text-script.html',
                                    'id': 'c-00000008',
                                    'resolved': False,
                                    'target': 'target',
                                    'entries': [],
                                },
                            ],
                        )

        with self.subTest('`<!--` and quotation marks inside `title` and `textarea` are read as text too'):
            # Reading the inside as markup would turn everything after an unclosed `<!--` into a comment, and would not
            # take a `</title>` written as an attribute value as the end. The editor reads the inside as text up to
            # `</title` and the like.
            self.assert_boundary_like_editor([
                (
                    'unclosed `<!--` in `title`',
                    f'<html><head><title>The <!-- token</title></head><body>{COMMENTED_PARAGRAPH}</body></html>',
                    True,
                ),
                (
                    'unclosed `<!--` in `textarea`',
                    f'<html><body><textarea>a <!-- b</textarea>{COMMENTED_PARAGRAPH}</body></html>',
                    True,
                ),
                (
                    '`</title>` as an attribute value in `title`',
                    '<html><head><title>a <b c="</title><body>">x</title></head>'
                    f'<body>{COMMENTED_PARAGRAPH}</body></html>',
                    False,
                ),
            ])

        with self.subTest('raw text ends where `</` and the element name are followed by whitespace, `/` or `>`'):
            # Older versions of `HTMLParser` look for the end only in the form `</script>`: they do not end at
            # `</script x>` but end at `</ script>`. Both are the opposite of the editor and change whether the
            # `<body>` after them is counted.
            documents = []
            for tag in ('script', 'style', 'title', 'textarea'):
                for end, opens in ((f'</{tag} x>', False), (f'</{tag}/>', False), (f'</ {tag}>', True),
                                   (f'</{tag.upper()}>', False)):
                    if tag == 'textarea':
                        document = f'<html><body><textarea>a{end}<body>b</textarea>{COMMENTED_PARAGRAPH}</body></html>'
                    else:
                        document = (
                            f'<html><head><{tag}>a{end}<body>b</{tag}></head>'
                            f'<body>{COMMENTED_PARAGRAPH}</body></html>'
                        )
                    documents.append((f'{end} in {tag}', document, opens))
            # An end tag does not close at a `>` inside quotation marks. Closing there would count the `<body>` in
            # the attribute value.
            documents.append((
                '`>` in an attribute value of the end tag',
                f'<html><head><script>a</script x="><body>"></head><body>{COMMENTED_PARAGRAPH}</body></html>',
                True,
            ))
            # The quotation mark is not closed, so no `>` closes the end tag. The editor does not treat it as an end
            # tag and reads what follows as tags.
            documents.append((
                'end tag without `>`',
                f'<html><head><script>a</script x="></head><body>{COMMENTED_PARAGRAPH}</body></html>',
                True,
            ))
            # Case in the element name is ignored for ASCII letters only. Raw text does not end at an end tag spelled
            # with `ſ` (U+017F) or `ı` (U+0131), which Unicode folds the same as `s` and `i`.
            for tag, spelling in (
                ('script', 'ſcript'), ('script', 'scrıpt'), ('style', 'ſtyle'), ('title', 'tıtle'),
            ):
                documents.append((
                    f'{tag} does not end at `</{spelling}>`',
                    f'<html><head><{tag}>a</{spelling}><body>b</{tag}></head><body>{COMMENTED_PARAGRAPH}</body></html>',
                    True,
                ))
            self.assert_boundary_like_editor(documents)
            # A `textarea` in the body also ends at the same position, and only the comments written after its end
            # are read.
            self.assert_body_comment_ids([
                (
                    'does not end at `</ſtyle>`',
                    '<style>a</ſtyle><comment id=c-00000026>inside</comment></style>',
                    ['c-00000011'],
                ),
                (
                    'comment after `</textarea x>`',
                    '<textarea>a</textarea x><comment id=c-00000015>after</comment>',
                    ['c-00000015', 'c-00000011'],
                ),
                (
                    'comment after `</ textarea>`',
                    '<textarea>a</ textarea><comment id=c-00000016>inside</comment></textarea>',
                    ['c-00000011'],
                ),
            ])

        with self.subTest('an HTML comment is skipped from `<!--` to the first `-->` after it'):
            # The editor closes it only at `-->`, but depending on the version, `HTMLParser` also closes it at `--!>`
            # or `-- >`. Versions differ in which of the two spellings closes it, so on any version, one of them fails
            # unless the closing matches the editor.
            for closing in ('--!>', '-- >'):
                with self.subTest(closing=closing):
                    self.assertEqual(
                        list_comments.extract_comments(
                            'html-comment.html',
                            f'<html><head><!-- closed by {closing} <body> --></head><body>'
                            '<p><comment id="c-00000009">target</comment></p></body></html>',
                        ),
                        [
                            {
                                'file': 'html-comment.html',
                                'id': 'c-00000009',
                                'resolved': False,
                                'target': 'target',
                                'entries': [],
                            },
                        ],
                    )
            # Inside the body it closes the same way, and comments written inside the HTML comment are not read.
            self.assert_body_comment_ids([
                ('comment after `--!>`', '<!-- a --!><comment id=c-00000017>inside</comment> -->', ['c-00000011']),
                ('comment after `-- >`', '<!-- a -- ><comment id=c-00000018>inside</comment> -->', ['c-00000011']),
            ])

        with self.subTest('without a `-->` after `<!-->` or `<!--->`, the rest of the document is read as a comment'):
            # Newer versions of `HTMLParser` close this as an empty comment and count the `<body>` after it.
            # The editor looks for `-->`, skips to the end of the document, and does not open it, as a document
            # without `<body>`.
            for opening in ('<!-->', '<!--->'):
                with self.subTest(opening=opening), self.assertRaises(ValueError):
                    list_comments.extract_comments(
                        'abrupt-comment.html',
                        f'<html><head>{opening}</head><body><p><comment id="c-00000010">target</comment></p>'
                        '</body></html>',
                    )
            # Inside the body it is not closed as an empty comment either, and comments written before the first
            # `-->` after it are not read.
            self.assert_body_comment_ids([
                ('comment after `<!-->`', '<!--><comment id=c-00000019>inside</comment>-->', ['c-00000011']),
                ('comment after `<!--->`', '<!---><comment id=c-00000019>inside</comment>-->', ['c-00000011']),
            ])

        with self.subTest('an unclosed `<!--` is read to the end of the document without relying on `HTMLParser`'):
            # Left to `HTMLParser`, older versions would read up to the next `>` as text and what follows as tags.
            # On newer versions, leaving it gives the same result, so check the position read up to, which fails on
            # any version.
            text = '<html><head><!--></head><body></body></html>'
            collector = list_comments._CommentCollector('unclosed-comment.html')
            collector.rawdata = text
            self.assertEqual(collector.parse_comment(text.index('<!--')), len(text))

        with self.subTest(
            '`<body>` inside and after the `<!`, `<?` and `</` that the editor does not read as tags counts toward'
            ' the body boundary'
        ):
            # `HTMLParser` reads these as units up to the next `>` (`<![CDATA[` up to `]]>`), but the editor does not
            # read `<` or `</` as a tag unless a tag name character follows, and counts `<body>` inside and after them.
            self.assert_boundary_like_editor([
                (
                    '`<body>` in `<![CDATA[`',
                    f'<html><head><![CDATA[<body>]]></head><body>{COMMENTED_PARAGRAPH}</body></html>',
                    False,
                ),
                (
                    '`<body>` after `<![CDATA[` without `]]>`',
                    f'<html><head><![CDATA[x</head><body>{COMMENTED_PARAGRAPH}</body></html>',
                    True,
                ),
                (
                    '`<body>` in `<!x`',
                    f'<html><head><!x <body> ></head><body>{COMMENTED_PARAGRAPH}</body></html>',
                    False,
                ),
                (
                    '`<body>` in `<!DOCTYPE`',
                    f'<!DOCTYPE <body>><html><body>{COMMENTED_PARAGRAPH}</body></html>',
                    False,
                ),
                (
                    '`<body>` in `<?`',
                    f'<html><head><?x <body> ?></head><body>{COMMENTED_PARAGRAPH}</body></html>',
                    False,
                ),
                (
                    '`<body>` in `</` followed by a space',
                    f'<html><head></ <body></head><body>{COMMENTED_PARAGRAPH}</body></html>',
                    False,
                ),
                (
                    '`</body>` in `<?`',
                    f'<html><body>{COMMENTED_PARAGRAPH}<? </body></html>',
                    True,
                ),
                (
                    '`</body>` in `<!x`',
                    f'<html><body>{COMMENTED_PARAGRAPH}<!x </body></html>',
                    True,
                ),
                # The editor reads `</` followed by an alphanumeric character as a tag and skips up to the next `>`.
                (
                    '`<body>` in `</1`',
                    f'<html><head></1 <body></head><body>{COMMENTED_PARAGRAPH}</body></html>',
                    True,
                ),
            ])
            # Inside the body they are not read as units either, and comments written after them are read.
            self.assert_body_comment_ids([
                (
                    'comment after `<![CDATA[`',
                    '<![CDATA[<comment id=c-00000020>inside</comment>]]>',
                    ['c-00000020', 'c-00000011'],
                ),
                ('comment after `<!x`', '<!x <comment id=c-00000021>inside</comment>>', ['c-00000021', 'c-00000011']),
                ('comment after `<?`', '<?x <comment id=c-00000022>inside</comment> ?>', ['c-00000022', 'c-00000011']),
                (
                    'comment after `</` followed by a space',
                    '</ <comment id=c-00000023>inside</comment>',
                    ['c-00000023', 'c-00000011'],
                ),
            ])

        with self.subTest('start tags closed with `/>`, both `<body/>` and `<comment/>`, are read as start tags only'):
            # By default, `HTMLParser` also passes on a `/>` start tag as an end tag, but the editor and the HTML
            # specification ignore the `/`.
            self.assert_boundary_like_editor([
                ('`<body/>`', f'<html><body/>{COMMENTED_PARAGRAPH}</body></html>', True),
            ])
            # A `<comment/>` in the body is not closed either, and the text and entries after it belong to that comment.
            self.assertEqual(
                list_comments.extract_comments(
                    'self-closing.html',
                    '<html><body><p><comment id="c-00000024"/>target<comment-body>body</comment-body></p></body></html>',
                ),
                [
                    {
                        'file': 'self-closing.html',
                        'id': 'c-00000024',
                        'resolved': False,
                        'target': 'target',
                        'entries': [{'kind': 'body', 'text': 'body', 'author': '', 'updated': ''}],
                    },
                ],
            )

        with self.subTest(
            'the body boundary reads a tag name as a run of alphanumeric characters regardless of case, as the editor'
            ' does'
        ):
            # Under the HTML specification, `<1` is not a tag and `<body-x>` is a tag named `body-x`, but the editor
            # takes a run of alphanumeric characters as the tag name. The `<body>` in `<1 <body>` is inside a tag and is
            # not counted, and `<body-x>` counts as a `body` tag. Names are compared in lowercase, so an uppercase
            # `<BODY>` counts the same as `<body>`.
            self.assert_boundary_like_editor([
                ('`<body>` in `<1`', f'<html><head><1 <body></head><body>{COMMENTED_PARAGRAPH}</body></html>', True),
                ('`</body>` in `<1`', f'<html><body>{COMMENTED_PARAGRAPH}<1 </body></html>', False),
                ('`<body-x>`', f'<html><head><body-x></head><body>{COMMENTED_PARAGRAPH}</body></html>', False),
                ('`</body-x>`', f'<html><body>{COMMENTED_PARAGRAPH}</body-x></body></html>', False),
                ('uppercase `<BODY>` and `</BODY>`', f'<HTML><BODY>{COMMENTED_PARAGRAPH}</BODY></HTML>', True),
                ('one `<body>` and one `<BODY>`', f'<html><body>{COMMENTED_PARAGRAPH}<BODY></body></html>', False),
            ])

        with self.subTest('`body` tags read inside the body are skipped'):
            # `HTMLParser` reads `body` tags even inside `<1 …>`, which the body boundary scan does not read as a tag.
            # Unless they are skipped as the browser does, the entries after them are no longer directly under
            # the comment.
            self.assertEqual(
                list_comments.extract_comments(
                    'body-in-body.html',
                    '<html><body><p><comment id="c-00000025">target<1 <body><comment-body>body</comment-body>'
                    '<1 </body></comment></p></body></html>',
                ),
                [
                    {
                        'file': 'body-in-body.html',
                        'id': 'c-00000025',
                        'resolved': False,
                        'target': 'target<1 <1',
                        'entries': [{'kind': 'body', 'text': 'body', 'author': '', 'updated': ''}],
                    },
                ],
            )

        with self.subTest(
            'the body boundary does not close a tag at a `>` inside quotation marks, and a tag with an unclosed'
            ' quotation mark is not a tag, as in the editor'
        ):
            # Older versions of `HTMLParser` close an end tag at a `>` inside quotation marks, and every version skips
            # `</1` up to the next `>`. The editor reads both up to a `>` outside quotation marks, and does not treat
            # a tag with an unclosed quotation mark as a tag, reading on after it.
            self.assert_boundary_like_editor([
                (
                    '`>` inside quotation marks in an end tag',
                    f'<html><head></p x=">" <body></head><body>{COMMENTED_PARAGRAPH}</body></html>',
                    True,
                ),
                (
                    '`>` inside quotation marks in `</1`',
                    f'<html><head></1 x=">" <body></head><body>{COMMENTED_PARAGRAPH}</body></html>',
                    True,
                ),
                (
                    '`</body>` after a tag with an unclosed quotation mark',
                    f'<html><body>{COMMENTED_PARAGRAPH}<p a="</body></html>',
                    True,
                ),
            ])

        with self.subTest(
            'end tags in the body do not close at a `>` inside quotation marks, and the rest of an unclosed'
            ' `textarea` is read as text'
        ):
            # Older versions of `HTMLParser` close an end tag at a `>` inside quotation marks and do not pass on the rest
            # of unclosed raw text as text. The browser closes an end tag at a `>` outside attribute quotation marks,
            # and discards an end tag not closed by `>` up to the end of the body. A quotation mark in the middle of
            # a name (`don't`) is just a character. An unclosed `textarea` reads as text up to the end of the body.
            self.assert_body_targets([
                (
                    '`>` inside quotation marks in an end tag',
                    '<p><comment id=c-00000027>before</strong x=">">after</comment></p>',
                    'beforeafter',
                ),
                (
                    'quotation mark in the middle of a name',
                    "<p><comment id=c-00000028>before</strong don't>after</comment></p>",
                    'beforeafter',
                ),
                (
                    'spaces around `=`, single quotation marks and `=` without a value',
                    "<p><comment id=c-00000034>before</strong x = '>' y=>after</comment></p>",
                    'beforeafter',
                ),
                (
                    'end tag not closed by `>`',
                    '<p><comment id=c-00000029>before</p x="after</comment><p>next</p>',
                    'before',
                ),
                (
                    'unclosed `textarea` starting after `<1`',
                    '<p><comment id=c-00000030>before<1 <textarea>x</ textarea></comment></p>',
                    'before<1 x</ textarea></comment></p>',
                ),
            ])

        with self.subTest('when an attribute name appears more than once, the first value is read'):
            # Under the HTML specification, only the first attribute with a given name takes effect. Match the values
            # the editor (the browser) reads.
            self.assertEqual(
                list_comments.extract_comments(
                    'duplicate-attributes.html',
                    '<html><body><p><comment id="c-00000031" id="c-00000032" data-resolved data-resolved="">target'
                    '<comment-body data-author="ai" data-author="human" data-updated="2026-01-01T00:00:00.000Z"'
                    ' data-updated="2026-01-02T00:00:00.000Z">body</comment-body></comment></p>'
                    '<p><comment id id="c-00000033">valueless attribute first</comment></p></body></html>',
                ),
                [
                    {
                        'file': 'duplicate-attributes.html',
                        'id': 'c-00000031',
                        'resolved': True,
                        'target': 'target',
                        'entries': [
                            {'kind': 'body', 'text': 'body', 'author': 'ai', 'updated': '2026-01-01T00:00:00.000Z'},
                        ],
                    },
                    {
                        'file': 'duplicate-attributes.html',
                        'id': '',
                        'resolved': False,
                        'target': 'valueless attribute first',
                        'entries': [],
                    },
                ],
            )

        with self.subTest('a missing ID or attribute, and an attribute without a written value, give empty strings'):
            self.assertEqual(
                list_comments.extract_comments(
                    'no-id.html',
                    '<html><body><p><comment>no attributes<comment-body>body</comment-body></comment>'
                    '<comment id>no values<comment-reply data-author data-updated>reply</comment-reply></comment></p>'
                    '</body></html>',
                ),
                [
                    {
                        'file': 'no-id.html',
                        'id': '',
                        'resolved': False,
                        'target': 'no attributes',
                        'entries': [{'kind': 'body', 'text': 'body', 'author': '', 'updated': ''}],
                    },
                    {
                        'file': 'no-id.html',
                        'id': '',
                        'resolved': False,
                        'target': 'no values',
                        'entries': [{'kind': 'reply', 'text': 'reply', 'author': '', 'updated': ''}],
                    },
                ],
            )

        with self.subTest('a comment with neither a body nor a reply is returned with empty entries'):
            self.assertEqual(
                list_comments.extract_comments(
                    'no-entries.html',
                    '<html><body><p><comment id="c-00000000">target only</comment></p></body></html>',
                ),
                [
                    {
                        'file': 'no-entries.html',
                        'id': 'c-00000000',
                        'resolved': False,
                        'target': 'target only',
                        'entries': [],
                    },
                ],
            )

        with self.subTest('for nested comments, the annotated text of the outer one includes that of the inner one'):
            self.assertEqual(
                list_comments.extract_comments(
                    'nested.html',
                    '<html><body><p><comment id="c-outer001">outer <comment id="c-inner001">inner'
                    '<comment-body data-author="ai">inner body</comment-body></comment> rest'
                    '<comment-body data-author="human">outer body</comment-body></comment></p></body></html>',
                ),
                [
                    {
                        'file': 'nested.html',
                        'id': 'c-outer001',
                        'resolved': False,
                        'target': 'outer inner rest',
                        'entries': [{'kind': 'body', 'text': 'outer body', 'author': 'human', 'updated': ''}],
                    },
                    {
                        'file': 'nested.html',
                        'id': 'c-inner001',
                        'resolved': False,
                        'target': 'inner',
                        'entries': [{'kind': 'body', 'text': 'inner body', 'author': 'ai', 'updated': ''}],
                    },
                ],
            )

        with self.subTest(
            'an entry written inside an entry does not count toward the thread and is read as text of the outer entry'
        ):
            self.assertEqual(
                list_comments.extract_comments(
                    'entry-in-entry.html',
                    '<html><body><p><comment id="c-00000001">target<comment-body data-author="human">body '
                    '<comment-reply data-author="ai">inner reply</comment-reply></comment-body></comment></p>'
                    '</body></html>',
                ),
                [
                    {
                        'file': 'entry-in-entry.html',
                        'id': 'c-00000001',
                        'resolved': False,
                        'target': 'target',
                        'entries': [{'kind': 'body', 'text': 'body inner reply', 'author': 'human', 'updated': ''}],
                    },
                ],
            )

        with self.subTest(
            'character references inside `textarea` are expanded, and the inside of `script` is returned as written'
        ):
            # Whether character references in raw text are expanded varies with the version of `HTMLParser`. The editor's
            # sidebar shows the inside of `textarea` expanded exactly once. The inside of `script` is read unexpanded, as
            # the HTML specification says (the editor does not open documents with `script` in the body, so it never
            # appears in the sidebar).
            # Expanded twice, `&amp;amp;` becomes `&`, which tells it apart from a single expansion.
            document = (
                '<html><body><p><comment id=c-00000012>A <textarea>B &amp;amp; C</textarea> <script>D &amp; E</script>'
                '<comment-body>F <textarea>&lt;G&gt;</textarea></comment-body></comment></p></body></html>'
            )
            for parser_name, parser_context in (('this version', contextlib.nullcontext), ('older version', old_html_parser)):
                with self.subTest(parser=parser_name), parser_context():
                    if parser_name == 'older version':
                        self.assert_old_html_parser()
                    comment = list_comments.extract_comments('character-reference.html', document)[0]
                    self.assertEqual(
                        (comment['target'], comment['entries'][0]['text']),
                        ('A B &amp; C D &amp; E', 'F <G>'),
                    )

        with self.subTest('the annotated text collapses runs of whitespace into one space and strips both ends'):
            comments = list_comments.extract_comments(
                'spaces.html',
                '<html><body><p><comment id="c-00000002">\n  the\n  annotated&nbsp;&nbsp;text&#x3000;\n'
                '<comment-body>body</comment-body>\n</comment></p></body></html>',
            )
            self.assertEqual(comments[0]['target'], 'the annotated text')

        with self.subTest('entry text is returned as written, whitespace included'):
            comments = list_comments.extract_comments(
                'entry-text.html',
                '<html><body><p><comment id="c-00000003">target'
                '<comment-body> line 1\n  line 2<br>line 3 </comment-body></comment></p></body></html>',
            )
            self.assertEqual(comments[0]['entries'][0]['text'], ' line 1\n  line 2line 3 ')

        with self.subTest('a comment without an end tag is read up to the end of the outer element or of the body'):
            documents = {
                'outer element': (
                    '<html><body><p><comment id="c-00000004">target<comment-body>body</comment-body></p>'
                    '<p>next paragraph</p></body></html>'
                ),
                'end of body': '<html><body><p><comment id="c-00000004">target<comment-body>body</comment-body></body></html>',
            }
            for end, document in documents.items():
                with self.subTest(end=end):
                    self.assertEqual(
                        list_comments.extract_comments('unclosed.html', document),
                        [
                            {
                                'file': 'unclosed.html',
                                'id': 'c-00000004',
                                'resolved': False,
                                'target': 'target',
                                'entries': [{'kind': 'body', 'text': 'body', 'author': '', 'updated': ''}],
                            },
                        ],
                    )

    def test_invalid_input(self):
        """If any input cannot be read, it fails naming the file and the reason, and returns results for no file."""
        valid = self.write('valid.html', DOCUMENT.encode('utf-8'))
        # The word "Japanese" written in Japanese (U+65E5 U+672C U+8A9E), encoded in Shift_JIS. It cannot be decoded
        # as UTF-8.
        shift_jis = b'<html><body><p>\x93\xfa\x96\x7b\x8c\xea</p></body></html>'
        # The kind of error, its input, the type of failure, and a word the reason should contain.
        cases = [
            (
                'no <body> start tag',
                self.write('no-start.html', b'<html><p>text</p></body></html>'),
                ValueError,
                '<body>',
            ),
            (
                'no <body> end tag',
                self.write('no-end.html', b'<html><body><p>text</p></html>'),
                ValueError,
                '<body>',
            ),
            (
                'two <body> start tags',
                self.write('two-starts.html', b'<html><body><body><p>text</p></body></html>'),
                ValueError,
                '<body>',
            ),
            (
                'two <body> end tags',
                self.write('two-ends.html', b'<html><body><p>text</p></body></body></html>'),
                ValueError,
                '<body>',
            ),
            (
                'another <body> start tag after the end tag',
                self.write('start-after-end.html', b'<html><body><p>text</p></body><body></html>'),
                ValueError,
                '<body>',
            ),
            (
                '<body> end tag before the start tag',
                self.write('reversed.html', b'<html></body><p>text</p><body></html>'),
                ValueError,
                '<body>',
            ),
            ('empty file', self.write('empty.html', b''), ValueError, '<body>'),
            ('file in an encoding other than UTF-8', self.write('shift-jis.html', shift_jis), ValueError, 'UTF-8'),
            ('nonexistent file', self.directory / 'missing.html', OSError, 'missing.html'),
        ]

        for label, invalid, error_type, reason in cases:
            with self.subTest(label, level='function'):
                with self.assertRaises(error_type) as raised:
                    list_comments.read_comments_from_files([valid, invalid])
                self.assertIn(str(invalid), str(raised.exception))
                self.assertIn(reason, str(raised.exception))

            with self.subTest(label, level='command'):
                completed = run_cli(valid, invalid)
                error_output = completed.stderr.decode('utf-8')
                self.assertEqual((completed.returncode, completed.stdout), (1, b''), error_output)
                # A crash with an exception also exits with code 1. A line starting with the file confirms that the
                # command stated the reason before exiting.
                self.assertIn(f'\n{invalid}: ', f'\n{error_output}')

    def test_filter_comments(self):
        """Resolution depends on whether `data-resolved` is present; matching comments keep their original order."""
        comments = list_comments.extract_comments('mixed.html', MIXED_DOCUMENT)

        with self.subTest('a comment with `data-resolved` is resolved, even when the value is false'):
            self.assertEqual([comment['resolved'] for comment in comments], [False, True, True, True])

        with self.subTest('all returns every comment'):
            self.assertEqual(list_comments.filter_comments(comments, 'all'), comments)

        with self.subTest('unresolved returns only unresolved comments'):
            self.assertEqual(list_comments.filter_comments(comments, 'unresolved'), comments[:1])

        with self.subTest('resolved returns only resolved comments'):
            self.assertEqual(list_comments.filter_comments(comments, 'resolved'), comments[1:])

        with self.subTest('an unknown status fails, listing the statuses that can be specified'):
            with self.assertRaises(ValueError) as raised:
                list_comments.filter_comments(comments, 'open')
            self.assertIn('unresolved', str(raised.exception))

    def test_cli(self):
        """The command returns matching comments as UTF-8 JSON, and fails without JSON on invalid arguments."""
        document = self.write('memo.html', DOCUMENT.encode('utf-8'))
        expected = expected_document_comments(str(document))

        with self.subTest('omitting the status returns every comment'):
            self.assertEqual(self.read_json(run_cli(document)), expected)

        with self.subTest('unresolved returns only unresolved comments'):
            self.assertEqual(self.read_json(run_cli('--status', 'unresolved', document)), expected[:1])

        with self.subTest('resolved returns only resolved comments'):
            self.assertEqual(self.read_json(run_cli('--status', 'resolved', document)), expected[1:])

        with self.subTest('with no matching comments, it returns an empty array and exits successfully'):
            plain = self.write('plain.html', '<html><body><p>No comments</p></body></html>'.encode('utf-8'))
            completed = run_cli('--status', 'resolved', plain)
            self.assertEqual((completed.returncode, completed.stdout.decode('utf-8').strip()), (0, '[]'))

        with self.subTest('reads input with a BOM'):
            with_bom = self.write('bom.html', b'\xef\xbb\xbf' + DOCUMENT.encode('utf-8'))
            self.assertEqual(self.read_json(run_cli(with_bom)), expected_document_comments(str(with_bom)))

        with self.subTest('writes Japanese in UTF-8 without escaping it'):
            self.assertIn(
                '\u73fe\u5728\u306e\u8a2d\u5b9a\u304b\u3089\u306e\u63a8\u6e2c\u3067\u3059\u3002'.encode('utf-8'),
                run_cli(document).stdout,
            )

        with self.subTest('an unknown status fails without JSON, listing the statuses that can be specified'):
            completed = run_cli('--status', 'open', document)
            error_output = completed.stderr.decode('utf-8')
            self.assertEqual((completed.returncode, completed.stdout), (1, b''), error_output)
            self.assertIn('unresolved', error_output)

        with self.subTest('without files, it fails without JSON and shows the usage'):
            completed = run_cli()
            error_output = completed.stderr.decode('utf-8')
            self.assertEqual((completed.returncode, completed.stdout), (1, b''), error_output)
            self.assertIn('file.html', error_output)

        with self.subTest('the reason for a failure is written in UTF-8 too'):
            # A Japanese file name (meaning "not created") does not come out as is unless standard error is UTF-8.
            completed = run_cli(self.directory / '\u672a\u4f5c\u6210.html')
            self.assertIn('\u672a\u4f5c\u6210.html', completed.stderr.decode('utf-8'))

    def test_read_only(self):
        """Listing comments changes neither the content nor the modification time of the input file."""
        # Give the file a BOM and CRLF, which rewriting would normalize, to confirm that it is only read.
        content = b'\xef\xbb\xbf' + DOCUMENT.replace('\n', '\r\n').encode('utf-8')
        document = self.write('memo.html', content)
        modified = document.stat().st_mtime_ns

        completed = run_cli('--status', 'unresolved', document)

        self.assertEqual(completed.returncode, 0, completed.stderr.decode('utf-8', 'replace'))
        self.assertEqual(document.read_bytes(), content)
        self.assertEqual(document.stat().st_mtime_ns, modified)


if __name__ == '__main__':
    unittest.main()
