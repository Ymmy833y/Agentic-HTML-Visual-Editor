import * as assert from 'node:assert';
import * as vscode from 'vscode';

// A test that checks VS Code's own behavior.
// It observes whether VS Code's text save participants (files.trimTrailingWhitespace,
// files.insertFinalNewline, editor.formatOnSave) run when the whole text is replaced in the text
// buffer and document.save() is called. If they do, lines the user never edited are rewritten on disk.
// The design in which a WYSIWYG save writes straight to disk rests on this observation, so the test is
// kept to catch the behavior changing.

const EXTENSION_ID = 'YuyaMiyamoto.agentic-html-visual-editor';

const SCRATCH_FILE_NAME = 'save-participants-scratch.html';

// Line 3 has trailing whitespace, line 4 has broken indentation, and there is no final newline.
// If the save participants run, at least one of those is rewritten.
const WRITTEN_TEXT =
  '<!DOCTYPE html>\n<html>\n<body>\n<p>a</p>   \n      <p>b</p>\n</body>\n</html>';

const INITIAL_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>x</p>\n</body>\n</html>\n';

function findExtension(): vscode.Extension<unknown> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} is not loaded in VS Code`);
  return extension;
}

// The extension path handed to the development host is the repository root.
function scratchUri(): vscode.Uri {
  return vscode.Uri.joinPath(
    findExtension().extensionUri,
    'tests',
    'integration',
    'fixtures',
    SCRATCH_FILE_NAME,
  );
}

const STATE_TIMEOUT_MS = 20000;
const POLLING_INTERVAL_MS = 100;

async function readDisk(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

// Discards whatever the previous case left unsaved in the buffer.
// closeAllEditors leaves a dirty buffer alive, and a dirty buffer never follows the content written to
// disk, so without this a single failing case would time out every case after it.
async function revertScratch(uri: vscode.Uri): Promise<void> {
  // Only an already-open buffer is looked at. Opening it here would fail before the first case, where the
  // scratch file does not exist on disk yet.
  const document = vscode.workspace.textDocuments.find(
    (candidate) => candidate.uri.toString() === uri.toString(),
  );
  if (!document?.isDirty) {
    return;
  }

  // revert acts on the active editor, so the document has to be brought to the front first.
  // The editor is closed again afterwards to leave the state the caller set up: the first case asserts
  // the behavior of a file that is not open in an editor.
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

// Writes the initial content, retrying while the file is locked.
// On Windows the previous case's save or VS Code's file watcher can still hold the file for a moment, so
// the write fails with EBUSY. The lock is transient, so a short retry is enough; any other error is real.
async function writeInitialText(uri: vscode.Uri): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;

  for (;;) {
    try {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(INITIAL_TEXT));
      return;
    } catch (error) {
      const locked = error instanceof Error && error.message.includes('EBUSY');
      if (!locked || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
    }
  }
}

// Writes back to disk and waits until the still-open buffer follows that content.
// Without the wait, the edit would land on a buffer still holding the previous test's content, and the
// reload arriving right afterwards would discard the edit, making save() a no-op.
async function resetScratch(uri: vscode.Uri): Promise<void> {
  await revertScratch(uri);
  await writeInitialText(uri);

  const document = await vscode.workspace.openTextDocument(uri);
  const deadline = Date.now() + STATE_TIMEOUT_MS;

  while (document.getText() !== INITIAL_TEXT) {
    assert.ok(Date.now() < deadline, 'the buffer did not follow the initial content');
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));
  }
}

async function updateSetting(section: string, key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
}

// Replaces the whole text, saves, and returns the content that landed on disk.
async function replaceAllAndSave(uri: vscode.Uri, text: string): Promise<string> {
  const document = await vscode.workspace.openTextDocument(uri);
  const wholeRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length),
  );

  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, wholeRange, text);
  assert.ok(await vscode.workspace.applyEdit(edit), 'the whole-text replacement was not applied');

  assert.ok(await document.save(), 'document.save() failed');
  return readDisk(uri);
}

describe('whether text save participants run on a programmatic save', () => {
  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetScratch(scratchUri());
  });

  after(async () => {
    await updateSetting('files', 'trimTrailingWhitespace', undefined);
    await updateSetting('files', 'insertFinalNewline', undefined);
    await updateSetting('editor', 'formatOnSave', undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(scratchUri());
  });

  // Measured: the save participants run even when the file is not open in a text editor.
  it('trims trailing whitespace and adds a final newline even when not open in an editor', async () => {
    await updateSetting('files', 'trimTrailingWhitespace', true);
    await updateSetting('files', 'insertFinalNewline', true);
    await updateSetting('editor', 'formatOnSave', false);

    const onDisk = await replaceAllAndSave(scratchUri(), WRITTEN_TEXT);

    assert.ok(!onDisk.includes('<p>a</p>   '), `trailing whitespace is still there: ${JSON.stringify(onDisk)}`);
    assert.ok(onDisk.endsWith('\n'), `no final newline was added: ${JSON.stringify(onDisk)}`);
  });

  it('runs the same way for a document open in an editor', async () => {
    await updateSetting('files', 'trimTrailingWhitespace', true);
    await updateSetting('files', 'insertFinalNewline', true);
    await updateSetting('editor', 'formatOnSave', false);

    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(scratchUri()));
    const onDisk = await replaceAllAndSave(scratchUri(), WRITTEN_TEXT);

    assert.ok(!onDisk.includes('<p>a</p>   '), `trailing whitespace is still there: ${JSON.stringify(onDisk)}`);
    assert.ok(onDisk.endsWith('\n'), `no final newline was added: ${JSON.stringify(onDisk)}`);
  });

  // Measured: formatOnSave rebuilds even the indentation the author wrote.
  // The details of the output vary with the formatter's version, so only the fact that an untouched
  // line changed is pinned down here.
  it('rebuilds the indentation of untouched lines under formatOnSave', async () => {
    await updateSetting('files', 'trimTrailingWhitespace', false);
    await updateSetting('files', 'insertFinalNewline', false);
    await updateSetting('editor', 'formatOnSave', true);

    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(scratchUri()));
    const onDisk = await replaceAllAndSave(scratchUri(), WRITTEN_TEXT);

    assert.ok(
      !onDisk.includes('      <p>b</p>'),
      `the indentation was preserved (the formatter did not run): ${JSON.stringify(onDisk)}`,
    );
  });
});
