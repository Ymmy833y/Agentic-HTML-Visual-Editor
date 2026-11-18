"""Tests for the reply script.

They run on the standard library alone. Run them with this directory as the start directory:
`python -m unittest discover -s <this directory>`.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import add_reply
import check_comments

SCRIPT_PATH = Path(__file__).with_name('add_reply.py')

# The time passed to the function, and how it is written.
NOW = datetime(2026, 1, 15, 9, 30, 0, 123456, tzinfo=timezone.utc)
WRITTEN_NOW = '2026-01-15T09:30:00.123Z'

# A document with a comment that has only a body, on line 8, and a comment that also has a reply, on line 9.
DOCUMENT = (
    '<!DOCTYPE html>\n'
    '<html lang="en">\n'
    '<head>\n'
    '<meta charset="utf-8">\n'
    '<title>Notes</title>\n'
    '</head>\n'
    '<body>\n'
    '<p>Saved <comment id="c-a1b2c3d4">every hour'
    '<comment-body contenteditable="false" data-author="ai" data-updated="2026-01-14T09:30:00.000Z">'
    'Is this right?</comment-body></comment>.</p>\n'
    '<p><comment id="c-e5f6a7b8">conflicts'
    '<comment-body contenteditable="false" data-author="ai" data-updated="2026-01-14T09:31:00.000Z">'
    'Keep both?</comment-body>'
    '<comment-reply contenteditable="false" data-author="human" data-updated="2026-01-14T10:00:00.000Z">'
    'Yes.</comment-reply></comment></p>\n'
    '</body>\n'
    '</html>\n'
)

# DOCUMENT with the first comment inside a link, where the editor puts a comment on part of the text of a link.
LINKED_DOCUMENT = DOCUMENT.replace(
    '<p>Saved <comment id="c-a1b2c3d4">every hour',
    '<p>Saved <a href="schedule.html">daily and <comment id="c-a1b2c3d4">every hour',
).replace('Is this right?</comment-body></comment>', 'Is this right?</comment-body></comment></a>')

# DOCUMENT with the first comment in a heading instead of a paragraph.
HEADING_DOCUMENT = DOCUMENT.replace(
    '<p>Saved <comment id="c-a1b2c3d4">', '<h2>Saved <comment id="c-a1b2c3d4">'
).replace('Is this right?</comment-body></comment>.</p>', 'Is this right?</comment-body></comment>.</h2>')

# A reply in Japanese. In English, it reads "Changed it to every 30 minutes."
JAPANESE_REPLY = '30 分ごとに変えました。'

# The form of `data-updated` the editor writes, and where the script writes it in a reply.
UPDATED_FORM = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z')
WRITTEN_UPDATED = re.compile(r'<comment-reply contenteditable="false" data-author="ai" data-updated="([^"]*)">')


def reply_entry(content, updated=WRITTEN_NOW):
    """The markup of a reply from the agent, written down from the comment rules without running the script."""
    return f'<comment-reply contenteditable="false" data-author="ai" data-updated="{updated}">{content}</comment-reply>'


def summarize(findings):
    """Reduce findings to their line, level and rule."""
    return [(finding['line'], finding['level'], finding['rule']) for finding in findings]


def run_cli(*arguments):
    """Run the script in a child process and return the result, which holds the exit code and the output bytes.

    The default encoding of standard output is set to one other than UTF-8, and any reliance on the default encoding
    stops with an error, as in the tests of the other scripts.
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


class AddReplyTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def write(self, name, content):
        """Write a file to the temporary directory as bytes, so that line endings are not converted, and return it."""
        path = self.directory / name
        path.write_bytes(content)
        return path

    def assert_unchanged(self, path, content, modified):
        """Check that a file keeps its content and its modification time."""
        self.assertEqual(path.read_bytes(), content)
        self.assertEqual(path.stat().st_mtime_ns, modified)

    def test_append_reply(self):
        """The reply goes right before the end tag of the comment, after its last entry, and nothing else changes."""
        with self.subTest('a comment with only a body gets the reply after the body'):
            updated, findings = add_reply.append_reply('notes.html', DOCUMENT, 'c-a1b2c3d4', 'Yes, every hour.', NOW)
            expected = DOCUMENT.replace(
                'Is this right?</comment-body></comment>',
                f'Is this right?</comment-body>{reply_entry("Yes, every hour.")}</comment>',
            )
            self.assertEqual((updated, findings), (expected, []))

        with self.subTest('a comment with replies gets the reply after the last one'):
            updated, findings = add_reply.append_reply('notes.html', DOCUMENT, 'c-e5f6a7b8', 'Kept both.', NOW)
            expected = DOCUMENT.replace(
                'Yes.</comment-reply></comment>',
                f'Yes.</comment-reply>{reply_entry("Kept both.")}</comment>',
            )
            self.assertEqual((updated, findings), (expected, []))

        with self.subTest('the time is written in UTC, whatever the time zone of the time given'):
            tokyo = NOW.astimezone(timezone(timedelta(hours=9)))
            updated, _ = add_reply.append_reply('notes.html', DOCUMENT, 'c-a1b2c3d4', 'answer', tokyo)
            self.assertIn(reply_entry('answer'), updated)

    def test_line_endings_and_whitespace(self):
        """The reply takes the line ending that prevails in the file and loses the whitespace around it."""
        crlf = DOCUMENT.replace('\n', '\r\n')

        with self.subTest('in a CRLF file, every line break in the reply becomes CRLF'):
            updated, _ = add_reply.append_reply('crlf.html', crlf, 'c-a1b2c3d4', 'one\ntwo\rthree\r\nfour', NOW)
            self.assertIn(reply_entry('one\r\ntwo\r\nthree\r\nfour'), updated)

        with self.subTest('the rest of a CRLF file keeps its line endings'):
            updated, _ = add_reply.append_reply('crlf.html', crlf, 'c-a1b2c3d4', 'one\ntwo', NOW)
            self.assertEqual(updated.replace(reply_entry('one\r\ntwo'), ''), crlf)

        with self.subTest('in an LF file, every line break in the reply becomes LF'):
            updated, _ = add_reply.append_reply('lf.html', DOCUMENT, 'c-a1b2c3d4', 'one\r\ntwo\rthree', NOW)
            self.assertIn(reply_entry('one\ntwo\nthree'), updated)

        with self.subTest('a file with more LF than CRLF takes LF'):
            mixed = DOCUMENT.replace('<head>\n', '<head>\r\n').replace('</head>\n', '</head>\r\n')
            updated, _ = add_reply.append_reply('mixed.html', mixed, 'c-a1b2c3d4', 'one\r\ntwo', NOW)
            self.assertIn(reply_entry('one\ntwo'), updated)

        with self.subTest('whitespace around the reply is dropped'):
            updated, _ = add_reply.append_reply('lf.html', DOCUMENT, 'c-a1b2c3d4', '\n  one\n two \t\r\n', NOW)
            self.assertIn(reply_entry('one\n two'), updated)

    def test_check(self):
        """A reply that adds an error comes back with it, while warnings alone and earlier problems do not stop it."""
        with self.subTest('a reply with its blocks in a template adds no problems'):
            _, findings = add_reply.append_reply(
                'notes.html', DOCUMENT, 'c-a1b2c3d4', '<template>\n<ul><li>one</li></ul>\n</template>', NOW
            )
            self.assertEqual(findings, [])

        with self.subTest('a reply with a block outside a template adds an error, on its line in the new text'):
            _, findings = add_reply.append_reply('notes.html', DOCUMENT, 'c-a1b2c3d4', 'Steps:\n<ul><li>one</li></ul>', NOW)
            self.assertEqual(summarize(findings), [(9, 'error', 'block-outside-template')])

        # A browser ends the paragraph around the comment at these too, though they are obsolete or rarely used.
        for name in ('center', 'dir', 'listing', 'search'):
            with self.subTest('an element that ends a paragraph, outside a template, adds an error', name=name):
                reply = f'Use <{name}>this</{name}> here.'
                _, findings = add_reply.append_reply('notes.html', DOCUMENT, 'c-a1b2c3d4', reply, NOW)
                self.assertEqual(summarize(findings), [(8, 'error', 'block-outside-template')])

        with self.subTest('a long reply of plain text adds only a warning'):
            _, findings = add_reply.append_reply('notes.html', DOCUMENT, 'c-a1b2c3d4', 'x' * 150, NOW)
            self.assertEqual(summarize(findings), [(8, 'warning', 'long-plain-entry')])

        with self.subTest('errors already in the document, in this comment or another, are not counted'):
            # The other comment has an ID of the wrong form, and the body of this one has no `data-updated`.
            broken = DOCUMENT.replace('c-e5f6a7b8', 'c-WRONG').replace(
                ' data-updated="2026-01-14T09:30:00.000Z"', ''
            )
            self.assertEqual(
                sorted(finding['rule'] for finding in check_comments.check_comments('broken.html', broken, NOW)),
                ['entry-attribute', 'id-format'],
                'the document does not have the errors this case relies on',
            )
            _, findings = add_reply.append_reply('broken.html', broken, 'c-a1b2c3d4', 'answer', NOW)
            self.assertEqual(findings, [])

    def test_invalid_input(self):
        """Without exactly one comment with the ID and an end tag, or with a reply that is empty, holds a forbidden tag,
        holds markup that a browser reads differently from this script, keeps the comment from ending right after it,
        leaves a start tag without its end or an element open, holds a start tag that Python can end elsewhere than a
        browser or read as text, holds a link while the comment is inside one, does not read back as written or holds a
        body tag, it fails naming the reason."""
        cases = {
            'no comment has the ID': (DOCUMENT, 'c-00000000', 'answer', 'no comment has the ID c-00000000'),
            'two comments have the ID': (
                DOCUMENT.replace('c-e5f6a7b8', 'c-a1b2c3d4'), 'c-a1b2c3d4', 'answer', '2 comments have the ID',
            ),
            'the comment has no end tag': (
                '<html><body><p><comment id="c-a1b2c3d4">target<comment-body>body</comment-body></p>'
                '<p>next</p></body></html>',
                'c-a1b2c3d4',
                'answer',
                'no </comment> end tag',
            ),
            'the reply is only whitespace': (DOCUMENT, 'c-a1b2c3d4', ' \n\t\r\n', 'is empty'),
            'the body boundary does not hold': ('<html><p>no body</p></html>', 'c-a1b2c3d4', 'answer', '<body>'),
            # The checks find nothing wrong here, but a browser closes the thread at the end tag and shows the rest of
            # the reply in the document body.
            'the reply closes the comment': (
                DOCUMENT, 'c-a1b2c3d4', 'a</comment>b', 'would no longer end right after the reply',
            ),
            'the reply closes the comment with an end tag in capitals': (
                DOCUMENT, 'c-e5f6a7b8', 'a</COMMENT >b', 'would no longer end right after the reply',
            ),
            # Nor in this one, but a browser closes the heading around the comment, and the comment with it, at the end
            # tag of a heading of any level, and shows the rest of the reply after the heading.
            'the reply closes the heading around the comment with the end tag of another level': (
                HEADING_DOCUMENT, 'c-a1b2c3d4', 'Close it with </h3> after the title.',
                'would no longer end right after the reply',
            ),
            # Nor in these, where a start tag does not end inside the reply: a browser reads what follows the reply as
            # part of the tag, up to a ">", or up to the same quotation mark when the reply leaves one open. Where
            # whitespace surrounds "=" or the attribute name holds a quotation mark, the way this script reads the
            # reply ends the tag at the first ">" when the document after the reply has no such mark, as here.
            'the reply leaves a quotation mark open': (
                DOCUMENT, 'c-a1b2c3d4', 'See <a href="notes.html>the notes</a>.',
                'leaves the start tag <a> without its end',
            ),
            'the reply leaves a quotation mark open after whitespace before "="': (
                DOCUMENT, 'c-e5f6a7b8', 'See <a href ="notes.html>the notes</a>.',
                'leaves the start tag <a> without its end',
            ),
            'the reply leaves a quotation mark open after whitespace after "="': (
                DOCUMENT, 'c-e5f6a7b8', 'See <a href= "notes.html>the notes</a>.',
                'leaves the start tag <a> without its end',
            ),
            'the reply leaves a quotation mark open after one in the attribute name': (
                DOCUMENT, 'c-e5f6a7b8', '<b a"=">x</b>', 'leaves the start tag <b> without its end',
            ),
            'the reply leaves a single quotation mark open after whitespace before "="': (
                DOCUMENT, 'c-a1b2c3d4', "See <a href ='notes.html>the notes</a>.",
                'leaves the start tag <a> without its end',
            ),
            'the reply ends inside a start tag': (
                DOCUMENT, 'c-a1b2c3d4', 'Swap them when a <b and b <c.', 'leaves the start tag <b> without its end',
            ),
            # Nor in this one, but a browser closes the link around the comment, and the comment with it, at the start
            # tag of the link in the reply, and shows the rest of the reply in the document body.
            'the reply holds a link and the comment is inside a link': (
                LINKED_DOCUMENT, 'c-a1b2c3d4', 'See <a href="notes.html">the notes</a>.', 'is inside a link',
            ),
            # Nor in these two, where every element is closed, but the editor does not open a document with a forbidden
            # tag anywhere in its body, even inside a template.
            'the reply holds a forbidden void element': (
                DOCUMENT, 'c-a1b2c3d4', 'Keep <code><meta charset="utf-8"></code> in the head.', 'holds <meta>',
            ),
            'the reply holds a forbidden element inside its template': (
                DOCUMENT,
                'c-a1b2c3d4',
                '<template>\n<pre><code><script>run()</script></code></pre>\n</template>',
                'holds <script>',
            ),
            # Nor in these two, where `list_comments.py` reads the tag as text but a browser reads it as an element: a
            # browser ends the HTML comment at `<!-->`, and reads the content of a `title` inside `svg` as markup.
            'the reply holds a forbidden tag after an HTML comment that a browser ends early': (
                DOCUMENT, 'c-a1b2c3d4', '<!--><meta>-->', 'holds <meta>',
            ),
            'the reply holds a forbidden tag inside the title of an svg': (
                DOCUMENT, 'c-a1b2c3d4', '<svg><title><meta></title></svg>', 'holds <meta>',
            ),
            # The editor lowercases a tag name with `toLowerCase()`, which turns the Kelvin sign (U+212A) into `k`, so
            # it refuses this tag as `link`, though a browser does not read it as one.
            'the reply holds a tag that the editor lowercases to a forbidden one': (
                DOCUMENT, 'c-a1b2c3d4', 'Use <lin\u212a> here.', 'holds <link>',
            ),
            # In these, the way this script reads the reply finds every element closed, but a browser leaves one open
            # past the end of the reply. A browser ends an HTML comment at `<!-->`, reads `<?`, any other `<!` and a
            # `</` not followed by a letter as a comment up to the next `>`, reads `title` inside `svg` and `math` as
            # markup, and reads the content of `xmp`, `noembed` and `noframes`, and everything after `<plaintext>`, as
            # text.
            'the reply holds an HTML comment that a browser ends early': (
                DOCUMENT, 'c-a1b2c3d4', '<!--><code>-->', 'holds "<!--"',
            ),
            # Every HTML comment is refused, so one that the reply leaves open, which would take in the end tags after
            # the reply, is refused for the same reason.
            'the reply leaves an HTML comment open': (DOCUMENT, 'c-a1b2c3d4', 'See <!-- the notes', 'holds "<!--"'),
            'the reply holds a <! that starts no HTML comment': (
                DOCUMENT, 'c-a1b2c3d4', '<code>x<!</code>>', 'holds "<!"',
            ),
            'the reply holds a <?': (DOCUMENT, 'c-a1b2c3d4', '<code>x<?</code>>', 'holds "<?"'),
            'the reply holds a </ not followed by a letter': (
                DOCUMENT, 'c-a1b2c3d4', '<code>x</ </code>>', 'holds "</"',
            ),
            'the reply holds an svg': (DOCUMENT, 'c-a1b2c3d4', '<svg><title><code></title></svg>', 'holds "<svg"'),
            'the reply holds a math element in capitals': (
                DOCUMENT, 'c-a1b2c3d4', '<MATH><title><code></title></MATH>', 'holds "<MATH"',
            ),
            'the reply holds an xmp': (DOCUMENT, 'c-a1b2c3d4', '<template><xmp></template></xmp>', 'holds "<xmp"'),
            'the reply holds a noembed': (
                DOCUMENT, 'c-a1b2c3d4', '<template><noembed></template></noembed>', 'holds "<noembed"',
            ),
            'the reply holds a noframes': (
                DOCUMENT, 'c-a1b2c3d4', '<template><noframes></template></noframes>', 'holds "<noframes"',
            ),
            'the reply holds a plaintext': (DOCUMENT, 'c-a1b2c3d4', '<plaintext>x</plaintext>', 'holds "<plaintext"'),
            # The checks find nothing wrong in these four either, but a browser reads the document after the comment
            # as the content of the element that the reply leaves open.
            'the reply leaves its template open': (
                DOCUMENT, 'c-a1b2c3d4', '<template>\n<p>one</p>', 'leaves <template> open',
            ),
            'the reply ends inside the end tag of its template': (
                DOCUMENT, 'c-a1b2c3d4', '<template>\n<p>one</p>\n</template', 'leaves <template> open',
            ),
            'the reply leaves an inline element open': (
                DOCUMENT, 'c-e5f6a7b8', 'Pass <code>--status and run it again.', 'leaves <code> open',
            ),
            'the reply closes an inline element only with the end tag of an outer one': (
                DOCUMENT, 'c-a1b2c3d4', 'Pass <strong><code>--status</strong> and run it again.', 'leaves <code> open',
            ),
            # Nor in this one, but an end tag of the reply ends it early. A browser shows only part of the reply.
            'the reply ends itself early': (
                DOCUMENT, 'c-a1b2c3d4', 'a</comment-reply>b', 'would not read back as written',
            ),
            # Without this case, the reason would say that the file has two `<body>` start tags, which it does not.
            'the reply holds a body tag': (DOCUMENT, 'c-a1b2c3d4', 'Move it under <body>.', 'holds a <body>'),
        }
        for label, (document, comment_id, reply, reason) in cases.items():
            with self.subTest(label):
                with self.assertRaises(ValueError) as raised:
                    add_reply.append_reply('invalid.html', document, comment_id, reply, NOW)
                self.assertIn(reason, str(raised.exception))

        # Versions of Python from before `HTMLParser` read attributes by the HTML specification end these start tags at
        # the last ">", where a browser ends them at the first one and reads the end tag after it. Which check refuses
        # them depends on the version, so only the refusal is checked.
        for reply in ('<a href=="x></comment>">link</a>', '<a href=\u3000"x></comment>">link</a>'):
            with self.subTest('a start tag that Python can end at a later ">" than a browser', reply=reply):
                with self.assertRaises(ValueError):
                    add_reply.append_reply('invalid.html', DOCUMENT, 'c-a1b2c3d4', reply, NOW)

        # The same versions take these start tags, which a browser ends at the first ">", as unfinished because of the
        # quotation mark left open after them, and read them as text. A browser opens the element, which takes in the
        # document after the comment. Again, only the refusal is checked.
        for reply in ('<template title=="x>" b=\'y', '<code title=\u3000"x>" b=\'y'):
            with self.subTest('a start tag that Python can read as text where a browser reads a tag', reply=reply):
                with self.assertRaises(ValueError):
                    add_reply.append_reply('invalid.html', DOCUMENT, 'c-a1b2c3d4', reply, NOW)

        with self.subTest('an escaped end tag does not close the comment'):
            reply = 'Write &lt;/comment&gt; here.'
            updated, findings = add_reply.append_reply('valid.html', DOCUMENT, 'c-a1b2c3d4', reply, NOW)
            self.assertIn(reply_entry(reply), updated)
            self.assertEqual(findings, [])

        with self.subTest('the end tag of a comment opened inside the reply is left to the checks'):
            reply = 'a<comment id="c-00000001">b</comment>c'
            _, findings = add_reply.append_reply('nested.html', DOCUMENT, 'c-a1b2c3d4', reply, NOW)
            self.assertEqual([finding['rule'] for finding in findings], ['comment-in-entry'])

        with self.subTest('elements closed by their own end tag, or by an outer one inside a template, are written'):
            reply = 'Pass <code>--status</code>.'
            updated, findings = add_reply.append_reply('valid.html', DOCUMENT, 'c-a1b2c3d4', reply, NOW)
            self.assertIn(reply_entry(reply), updated)
            self.assertEqual(findings, [])
            # The end tags of the list items are left out, and the end tag of the list closes them. A browser carries
            # nothing in a template past its end.
            reply = '<template>\n<ul><li>one<li><strong>two</ul>\n</template>'
            updated, findings = add_reply.append_reply('valid.html', DOCUMENT, 'c-a1b2c3d4', reply, NOW)
            self.assertIn(reply_entry(reply), updated)
            self.assertEqual(findings, [])

        with self.subTest('in a heading, a heading closed in the template of the reply is written'):
            # The end tag closes the innermost open heading, which is the one in the template, not the one around the
            # comment.
            reply = '<template>\n<h3>Steps</h3>\n</template>'
            updated, findings = add_reply.append_reply('valid.html', HEADING_DOCUMENT, 'c-a1b2c3d4', reply, NOW)
            self.assertIn(reply_entry(reply), updated)
            self.assertEqual(findings, [])

        with self.subTest('a quoted value that the reply closes is written, even with whitespace around "=" or a ">"'):
            reply = 'See <a href = "notes.html" title="a > b">the notes</a>.'
            updated, findings = add_reply.append_reply('valid.html', DOCUMENT, 'c-e5f6a7b8', reply, NOW)
            self.assertIn(reply_entry(reply), updated)
            self.assertEqual(findings, [])

        with self.subTest('a link is written, and for a comment inside a link, inside a template'):
            reply = 'See <a href="notes.html">the notes</a>.'
            updated, findings = add_reply.append_reply('valid.html', DOCUMENT, 'c-a1b2c3d4', reply, NOW)
            self.assertIn(reply_entry(reply), updated)
            self.assertEqual(findings, [])
            reply = '<template>\n<p>See <a href="notes.html">the notes</a>.</p>\n</template>'
            updated, findings = add_reply.append_reply('valid.html', LINKED_DOCUMENT, 'c-a1b2c3d4', reply, NOW)
            self.assertIn(reply_entry(reply), updated)
            self.assertEqual(findings, [])

        with self.subTest('a "<" that starts no tag is written as it is'):
            reply = 'Swap them when a < b.'
            updated, findings = add_reply.append_reply('valid.html', DOCUMENT, 'c-a1b2c3d4', reply, NOW)
            self.assertIn(reply_entry(reply), updated)
            self.assertEqual(findings, [])

        with self.subTest('a forbidden tag written as text is written as it is'):
            reply = 'Keep <code>&lt;meta charset="utf-8"&gt;</code> in the head.'
            updated, findings = add_reply.append_reply('valid.html', DOCUMENT, 'c-a1b2c3d4', reply, NOW)
            self.assertIn(reply_entry(reply), updated)
            self.assertEqual(findings, [])

        with self.subTest('markup that a browser reads differently, written as text, is written as it is'):
            reply = 'Write <code>&lt;!-- --&gt;</code>, <code>&lt;?</code> and <code>&lt;svg&gt;</code> as text.'
            updated, findings = add_reply.append_reply('valid.html', DOCUMENT, 'c-a1b2c3d4', reply, NOW)
            self.assertIn(reply_entry(reply), updated)
            self.assertEqual(findings, [])

        with self.subTest('an element whose name only starts like one of those is written'):
            reply = 'Use <svg-icon>the icon</svg-icon>.'
            updated, findings = add_reply.append_reply('valid.html', DOCUMENT, 'c-a1b2c3d4', reply, NOW)
            self.assertIn(reply_entry(reply), updated)
            self.assertEqual(findings, [])

        with self.subTest('a block left open outside a template is left to the checks'):
            _, findings = add_reply.append_reply('block.html', DOCUMENT, 'c-a1b2c3d4', 'Steps:<p>one', NOW)
            self.assertEqual([finding['rule'] for finding in findings], ['block-outside-template'])

    def test_cli(self):
        """The command writes the reply with the time of the run, and writes its results in UTF-8."""
        with self.subTest('writes a Japanese reply given with --reply, and returns an empty array'):
            document = self.write('reply.html', DOCUMENT.encode('utf-8'))
            completed = run_cli('--id', 'c-a1b2c3d4', '--reply', JAPANESE_REPLY, document)
            self.assertEqual(
                (completed.returncode, json.loads(completed.stdout.decode('utf-8'))),
                (0, []),
                completed.stderr.decode('utf-8', 'replace'),
            )
            self.assertIn(f'{JAPANESE_REPLY}</comment-reply></comment>'.encode('utf-8'), document.read_bytes())

        with self.subTest('writes a Japanese reply given with --reply-file, from a file with a BOM'):
            document = self.write('reply-file.html', DOCUMENT.encode('utf-8'))
            reply = self.write('reply.txt', b'\xef\xbb\xbf' + f'{JAPANESE_REPLY}\n'.encode('utf-8'))
            completed = run_cli('--id', 'c-a1b2c3d4', '--reply-file', reply, document)
            self.assertEqual(completed.returncode, 0, completed.stderr.decode('utf-8', 'replace'))
            self.assertIn(f'">{JAPANESE_REPLY}</comment-reply></comment>'.encode('utf-8'), document.read_bytes())

        with self.subTest('keeps the BOM and the CRLF line endings of the file'):
            content = b'\xef\xbb\xbf' + DOCUMENT.replace('\n', '\r\n').encode('utf-8')
            document = self.write('bom-crlf.html', content)
            completed = run_cli('--id', 'c-a1b2c3d4', '--reply', 'one\ntwo', document)
            self.assertEqual(completed.returncode, 0, completed.stderr.decode('utf-8', 'replace'))
            written = document.read_bytes()
            updated = WRITTEN_UPDATED.search(written.decode('utf-8')).group(1)
            self.assertEqual(written.replace(reply_entry('one\r\ntwo', updated).encode('utf-8'), b''), content)

        with self.subTest('writes data-updated as the UTC time of the run, with milliseconds and Z'):
            document = self.write('time.html', DOCUMENT.encode('utf-8'))
            before = datetime.now(timezone.utc).replace(microsecond=0)
            completed = run_cli('--id', 'c-a1b2c3d4', '--reply', 'answer', document)
            after = datetime.now(timezone.utc)
            self.assertEqual(completed.returncode, 0, completed.stderr.decode('utf-8', 'replace'))
            updated = WRITTEN_UPDATED.search(document.read_text(encoding='utf-8')).group(1)
            self.assertRegex(updated, UPDATED_FORM)
            written_time = datetime.strptime(updated, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
            self.assertTrue(before <= written_time <= after, f'{updated} is not between {before} and {after}')

        with self.subTest('a reply that adds an error leaves the file as it was and returns the errors in UTF-8'):
            content = DOCUMENT.encode('utf-8')
            document = self.write('refused.html', content)
            modified = document.stat().st_mtime_ns
            # A comment inside the reply, with an ID in Japanese (meaning "Japan"), which also has the wrong form.
            completed = run_cli('--id', 'c-a1b2c3d4', '--reply', '<comment id="日本">x</comment>', document)
            self.assertEqual(completed.returncode, 1, completed.stderr.decode('utf-8', 'replace'))
            findings = json.loads(completed.stdout.decode('utf-8'))
            self.assertEqual(
                sorted((finding['id'], finding['rule']) for finding in findings),
                [('日本', 'comment-in-entry'), ('日本', 'id-format')],
            )
            self.assert_unchanged(document, content, modified)

        with self.subTest('a reply that adds only a warning is written, and the warning returned with exit code 0'):
            document = self.write('warning.html', DOCUMENT.encode('utf-8'))
            completed = run_cli('--id', 'c-a1b2c3d4', '--reply', 'x' * 150, document)
            self.assertEqual(completed.returncode, 0, completed.stderr.decode('utf-8', 'replace'))
            self.assertEqual(
                [finding['rule'] for finding in json.loads(completed.stdout.decode('utf-8'))], ['long-plain-entry']
            )
            self.assertIn(f'{"x" * 150}</comment-reply>'.encode('utf-8'), document.read_bytes())

        with self.subTest('the reason for a failure is written in UTF-8 too'):
            # A Japanese file name (meaning "not created") does not come out as is unless standard error is UTF-8.
            completed = run_cli('--id', 'c-a1b2c3d4', '--reply', 'answer', self.directory / '未作成.html')
            self.assertIn('未作成.html', completed.stderr.decode('utf-8'))

    def test_invalid_arguments(self):
        """Arguments that cannot be used fail without JSON, and the file keeps its content and modification time."""
        content = DOCUMENT.encode('utf-8')
        document = self.write('notes.html', content)
        modified = document.stat().st_mtime_ns
        reply = self.write('reply.txt', b'answer')
        cases = {
            'both --reply and --reply-file': ('--id', 'c-a1b2c3d4', '--reply', 'answer', '--reply-file', reply, document),
            'neither --reply nor --reply-file': ('--id', 'c-a1b2c3d4', document),
            'a reply file that does not exist': (
                '--id', 'c-a1b2c3d4', '--reply-file', self.directory / 'missing.txt', document,
            ),
            'no --id': ('--reply', 'answer', document),
            'no HTML file': ('--id', 'c-a1b2c3d4', '--reply', 'answer'),
            'an ID that no comment has': ('--id', 'c-00000000', '--reply', 'answer', document),
        }
        for label, arguments in cases.items():
            with self.subTest(label):
                completed = run_cli(*arguments)
                error_output = completed.stderr.decode('utf-8', 'replace')
                self.assertEqual((completed.returncode, completed.stdout), (1, b''), error_output)
                self.assertTrue(error_output.strip(), 'the reason for the failure is not written')
                self.assert_unchanged(document, content, modified)


if __name__ == '__main__':
    unittest.main()
