"""Tests for the comment checking script.

They run on the standard library alone. Run them with this directory as the start directory:
`python -m unittest discover -s <this directory>`.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import check_comments

SCRIPT_PATH = Path(__file__).with_name('check_comments.py')

# The time the checks treat as now, so that the results do not depend on the clock.
NOW = datetime(2026, 6, 1, tzinfo=timezone.utc)

# Valid attributes for an entry written by an agent.
ENTRY_ATTRIBUTES = 'contenteditable="false" data-author="ai" data-updated="2026-01-15T09:30:00.000Z"'

# A document whose comments break no rule: a plain body with a human reply, and a reply whose blocks are in a
# `template` with whitespace around it.
VALID_DOCUMENT = (
    '<!DOCTYPE html>\n'
    '<html lang="en">\n'
    '<head>\n'
    '<meta charset="utf-8">\n'
    '<title>Notes</title>\n'
    '</head>\n'
    '<body>\n'
    '<p id="intro">The cache is <comment id="c-a1b2c3d4">cleared <strong>every hour</strong>'
    f'<comment-body {ENTRY_ATTRIBUTES}>Assumed from the configuration.\nPlease confirm.</comment-body>'
    '<comment-reply contenteditable="false" data-author="human" data-updated="2026-01-15T10:02:41.512Z">'
    'Every 30 minutes &amp; on deploy.</comment-reply>'
    f'<comment-reply {ENTRY_ATTRIBUTES}>\n<template>\n<p>Two options:</p>\n'
    '<ul><li>Every 30 minutes.</li><li>On each deploy.</li></ul>\n'
    '<blockquote data-alert="warning"><p>Assumed.</p></blockquote>\n</template>\n</comment-reply></comment>.</p>\n'
    '</body>\n'
    '</html>\n'
)


def body_document(fragment):
    """Return a document whose body holds `fragment` on its first line, which is line 2 of the file."""
    return f'<html><body>\n{fragment}\n</body></html>\n'


def summarize(findings):
    """Reduce findings to (rule, level, id, line), the parts the cases check."""
    return [(finding['rule'], finding['level'], finding['id'], finding['line']) for finding in findings]


class CheckCommentsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def write(self, name, content):
        path = self.directory / name
        path.write_bytes(content.encode('utf-8'))
        return path

    def check(self, fragment):
        return summarize(check_comments.check_comments('doc.html', body_document(fragment), NOW))

    def test_valid_document(self):
        """A document whose comments follow every rule gives no findings."""
        self.assertEqual(check_comments.check_comments('valid.html', VALID_DOCUMENT, NOW), [])

    def test_errors(self):
        """Each rule reports the problem it is about, with the comment it belongs to and its line."""
        cases = [
            (
                'a comment without an ID',
                f'<p><comment>t<comment-body {ENTRY_ATTRIBUTES}>b</comment-body></comment></p>',
                [('id-format', 'error', '', 2)],
            ),
            (
                'an ID not in the form c- and 8 lowercase letters or digits',
                f'<p><comment id="c-ABCDEFGH">t<comment-body {ENTRY_ATTRIBUTES}>b</comment-body></comment>'
                f'<comment id="c-1234567">t<comment-body {ENTRY_ATTRIBUTES}>b</comment-body></comment></p>',
                [('id-format', 'error', 'c-ABCDEFGH', 2), ('id-format', 'error', 'c-1234567', 2)],
            ),
            (
                'an ID that another element in the body also has',
                f'<h2 id="c-00000001">x</h2>\n<p><comment id="c-00000001">t<comment-body {ENTRY_ATTRIBUTES}>b'
                '</comment-body></comment></p>',
                [('id-duplicate', 'error', 'c-00000001', 3)],
            ),
            (
                'a comment inside the annotated text of another comment',
                f'<p><comment id="c-00000001">a <comment id="c-00000002">b</comment>'
                f'<comment-body {ENTRY_ATTRIBUTES}>x</comment-body></comment></p>',
                [('nested-comment', 'error', 'c-00000002', 2)],
            ),
            (
                'a block in the annotated text, reported once for its outermost block',
                f'<p><comment id="c-00000001">a<ul><li>b</li></ul><comment-body {ENTRY_ATTRIBUTES}>x</comment-body>'
                '</comment></p>',
                [('block-in-target', 'error', 'c-00000001', 2)],
            ),
            (
                'a second body',
                f'<p><comment id="c-00000001">t<comment-body {ENTRY_ATTRIBUTES}>a</comment-body>'
                f'<comment-body {ENTRY_ATTRIBUTES}>b</comment-body></comment></p>',
                [('entry-order', 'error', 'c-00000001', 2)],
            ),
            (
                'a body after a reply',
                f'<p><comment id="c-00000001">t<comment-reply {ENTRY_ATTRIBUTES}>a</comment-reply>'
                f'<comment-body {ENTRY_ATTRIBUTES}>b</comment-body></comment></p>',
                [('entry-order', 'error', 'c-00000001', 2)],
            ),
            (
                'annotated text after the entries, reported once per comment',
                f'<p><comment id="c-00000001">t<comment-body {ENTRY_ATTRIBUTES}>a</comment-body> more <em>text</em>'
                '</comment></p>',
                [('entry-order', 'error', 'c-00000001', 2)],
            ),
            (
                'entry attributes that are missing or have other values',
                '<p><comment id="c-00000001">t<comment-body>a</comment-body>'
                '<comment-reply contenteditable="true" data-author="AI" data-updated="2026-01-15T09:30:00Z">b'
                '</comment-reply><comment-reply contenteditable="false" data-author="human"'
                ' data-updated="2026-13-01T00:00:00.000Z">c</comment-reply></comment></p>',
                [('entry-attribute', 'error', 'c-00000001', 2)] * 7,
            ),
            (
                'a template beside other content, and a second template',
                f'<p><comment id="c-00000001">t<comment-body {ENTRY_ATTRIBUTES}>text<template><p>a</p></template>'
                '</comment-body>'
                f'<comment-reply {ENTRY_ATTRIBUTES}><template><p>a</p></template><template><p>b</p></template>'
                '</comment-reply></comment></p>',
                [('template-misuse', 'error', 'c-00000001', 2)] * 2,
            ),
            (
                'a template outside an entry',
                '<template><p>stray</p></template>\n'
                f'<p><comment id="c-00000001"><template>t</template><comment-body {ENTRY_ATTRIBUTES}>a</comment-body>'
                '</comment></p>',
                [('template-misuse', 'error', '', 2), ('template-misuse', 'error', 'c-00000001', 3)],
            ),
            (
                'a block directly in an entry, reported once for its outermost block',
                f'<p><comment id="c-00000001">t<comment-body {ENTRY_ATTRIBUTES}><ul><li>a</li></ul></comment-body>'
                '</comment></p>',
                [('block-outside-template', 'error', 'c-00000001', 2)],
            ),
            (
                'a comment inside an entry',
                f'<p><comment id="c-00000001">t<comment-body {ENTRY_ATTRIBUTES}>a <comment id="c-00000002">b'
                '</comment></comment-body></comment></p>',
                [('comment-in-entry', 'error', 'c-00000002', 2)],
            ),
        ]
        for label, fragment, expected in cases:
            with self.subTest(label):
                self.assertEqual(self.check(fragment), expected)

    def test_messages_name_the_values(self):
        """A message about an attribute says which value was found, so that it can be fixed without looking it up."""
        findings = check_comments.check_comments(
            'doc.html',
            body_document(
                '<p><comment id="c-00000001">t<comment-body contenteditable="false" data-updated="2026-01-15">a'
                '</comment-body></comment></p>'
            ),
            NOW,
        )
        self.assertEqual(
            [finding['message'] for finding in findings],
            [
                'data-author is missing, not ai or human',
                'data-updated is "2026-01-15", not a UTC time such as 2026-01-15T09:30:00.000Z',
            ],
        )

    def test_warnings(self):
        """Long entries without blocks and times later than now are warnings, not errors."""
        long_line = 'x' * 150
        cases = [
            ('two lines', 'line 1\nline 2', []),
            ('three lines', 'line 1\n\nline 2\nline 3', [('long-plain-entry', 'warning', 'c-00000001', 2)]),
            ('149 characters', 'x' * 149, []),
            ('150 characters', long_line, [('long-plain-entry', 'warning', 'c-00000001', 2)]),
            ('150 characters with markup, counted without tags', f'<strong>{"x" * 75}</strong>{"x" * 75}',
             [('long-plain-entry', 'warning', 'c-00000001', 2)]),
            ('a long entry in a template', f'<template><p>{long_line}</p></template>', []),
        ]
        for label, content, expected in cases:
            with self.subTest(label):
                self.assertEqual(
                    self.check(
                        f'<p><comment id="c-00000001">t<comment-body {ENTRY_ATTRIBUTES}>{content}</comment-body>'
                        '</comment></p>'
                    ),
                    expected,
                )
        with self.subTest('a time later than now'):
            self.assertEqual(
                self.check(
                    '<p><comment id="c-00000001">t<comment-body contenteditable="false" data-author="ai"'
                    ' data-updated="2026-06-01T00:00:00.001Z">a</comment-body></comment></p>'
                ),
                [('future-updated', 'warning', 'c-00000001', 2)],
            )

    def test_lines_count_from_the_start_of_the_file(self):
        """The line of a finding is the line of the file, counting the lines before the body."""
        findings = check_comments.check_comments('doc.html', VALID_DOCUMENT.replace('c-a1b2c3d4', 'bad'), NOW)
        self.assertEqual(summarize(findings), [('id-format', 'error', 'bad', 8)])

    def test_invalid_input(self):
        """A document without exactly one body cannot be checked."""
        with self.assertRaises(ValueError):
            check_comments.check_comments('doc.html', '<html><p>no body</p></html>', NOW)

    def run_cli(self, *arguments, isolated=False):
        return subprocess.run(
            [sys.executable, *(['-I'] if isolated else []), str(SCRIPT_PATH), *map(str, arguments)],
            capture_output=True,
            check=False,
            cwd=self.directory,
        )

    def test_cli(self):
        """The exit code tells whether there is an error, and a file that cannot be checked gives no JSON."""
        valid = self.write('valid.html', VALID_DOCUMENT)
        warning = self.write('warning.html', body_document(
            f'<p><comment id="c-00000001">t<comment-body {ENTRY_ATTRIBUTES}>{"x" * 150}</comment-body></comment></p>'
        ))
        error = self.write('error.html', body_document('<p><comment id="bad">t</comment></p>'))

        with self.subTest('no findings'):
            completed = self.run_cli(valid)
            self.assertEqual((completed.returncode, json.loads(completed.stdout.decode('utf-8'))), (0, []))

        with self.subTest('warnings alone exit with 0'):
            completed = self.run_cli(warning)
            self.assertEqual(completed.returncode, 0)
            self.assertEqual([finding['rule'] for finding in json.loads(completed.stdout)], ['long-plain-entry'])

        with self.subTest('an error exits with 1, and the findings of every file are listed in the given order'):
            completed = self.run_cli(error, warning)
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(
                [(Path(finding['file']).name, finding['rule']) for finding in json.loads(completed.stdout)],
                [('error.html', 'id-format'), ('warning.html', 'long-plain-entry')],
            )

        with self.subTest('in isolated mode the shared reader is still found'):
            completed = self.run_cli(valid, isolated=True)
            self.assertEqual(completed.returncode, 0, completed.stderr.decode('utf-8', 'replace'))

        with self.subTest('a missing file exits with 1, writes the reason and no JSON'):
            completed = self.run_cli(valid, self.directory / 'missing.html')
            self.assertEqual((completed.returncode, completed.stdout), (1, b''))
            self.assertIn('missing.html', completed.stderr.decode('utf-8'))

        with self.subTest('no file exits with 1'):
            self.assertEqual(self.run_cli().returncode, 1)

    def test_read_only(self):
        """Checking leaves the file exactly as it was."""
        path = self.write('error.html', body_document('<p><comment id="bad">t<ul><li>x</li></ul></comment></p>'))
        before = path.read_bytes()
        self.run_cli(path)
        self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
