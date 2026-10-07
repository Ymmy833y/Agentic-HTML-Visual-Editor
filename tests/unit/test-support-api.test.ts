// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { ViewToHostMessage } from '../../common/index';
import type { SessionInspection } from '../../src/session/session-registry';
import {
  EMPTY_SESSION_INSPECTION,
  createTestSupportApi,
} from '../../src/testing/test-support-api';
import type {
  BackupTestAccess,
  TestSupportDependencies,
  TestSupportSession,
} from '../../src/testing/test-support-api';
import type { WebviewInspection } from '../../src/testing/webview-inspection';

const SESSION_INSPECTION: SessionInspection = {
  documentUris: ['file:///document.html'],
  activeDocumentUri: 'file:///document.html',
};

const RECORDED_URI = 'file:///document.html';

const WEBVIEW_INSPECTION: WebviewInspection = {
  html: '<p>body</p>',
  enableScripts: true,
  enableCommandUris: false,
  enableForms: false,
  localResourceRoots: [],
  iconPath: undefined,
  messages: [],
  sourceChangeTriggers: [],
};

/**
 * Mimics the read port of an observation point that holds only the most recent panel.
 *
 * @param documentUri The canonical form of the URI the inspection looks up.
 */
function readRecordedInspection(documentUri: string): WebviewInspection | undefined {
  return documentUri === RECORDED_URI ? WEBVIEW_INSPECTION : undefined;
}

/** Creates the default dependencies with only the parts a test cares about overridden. */
function createDependencies(
  overrides: Partial<TestSupportDependencies> = {},
): TestSupportDependencies {
  return {
    enabled: true,
    normalizeDocumentUri: (documentUri) => documentUri,
    findSession: () => undefined,
    readWebviewInspection: () => undefined,
    readSessionInspection: () => SESSION_INSPECTION,
    readDiagnosticInspection: () => ({ notifications: ['notification'], logLines: ['log line'] }),
    clearDiagnosticInspection: () => undefined,
    readSaveEntryInspection: () => ({ calls: [] }),
    clearSaveEntryInspection: () => undefined,
    backupAccess: () => undefined,
    ...overrides,
  };
}

describe('test support API', () => {
  it('returns the session inspection as-is when enabled', () => {
    const api = createTestSupportApi(createDependencies());

    expect(api.readSessionInspection()).toBe(SESSION_INSPECTION);
  });

  it('returns an empty copy without reading the session registry when disabled', () => {
    let reads = 0;
    const api = createTestSupportApi(createDependencies({
      enabled: false,
      readSessionInspection: () => {
        reads += 1;
        return SESSION_INSPECTION;
      },
    }));

    expect([api.readSessionInspection(), reads]).toEqual([EMPTY_SESSION_INSPECTION, 0]);
  });

  it('represents no registrations and no active target in the empty copy', () => {
    expect(EMPTY_SESSION_INSPECTION).toEqual({
      documentUris: [],
      activeDocumentUri: undefined,
    });
  });

  it('passes a clear request on to the observation points when enabled', () => {
    const cleared: string[] = [];
    const api = createTestSupportApi(createDependencies({
      clearDiagnosticInspection: () => cleared.push('diagnostic'),
      clearSaveEntryInspection: () => cleared.push('save'),
    }));

    api.clearDiagnosticInspection();
    api.clearSaveEntryInspection();

    expect(cleared).toEqual(['diagnostic', 'save']);
  });

  it('does not pass a clear request on to the observation points when disabled', () => {
    const cleared: string[] = [];
    const api = createTestSupportApi(createDependencies({
      enabled: false,
      clearDiagnosticInspection: () => cleared.push('diagnostic'),
      clearSaveEntryInspection: () => cleared.push('save'),
    }));

    api.clearDiagnosticInspection();
    api.clearSaveEntryInspection();

    expect(cleared).toEqual([]);
  });

  it('returns the copy for a recorded panel and no target, not an exception, for another file', () => {
    const api = createTestSupportApi(createDependencies({
      readWebviewInspection: readRecordedInspection,
    }));

    expect([
      api.readWebviewInspection(RECORDED_URI),
      api.readWebviewInspection('file:///other.html'),
    ]).toEqual([WEBVIEW_INSPECTION, undefined]);
  });

  it('looks up the target with the normalized spelling for both inspection and drive hooks', async () => {
    const lookups: string[] = [];
    const session = createSession();
    const api = createTestSupportApi(createDependencies({
      normalizeDocumentUri: () => 'file:///normalized.html',
      readWebviewInspection: (documentUri) => {
        lookups.push(`inspection:${documentUri}`);
        return undefined;
      },
      findSession: (documentUri) => {
        lookups.push(`session:${documentUri}`);
        return session;
      },
    }));

    api.readWebviewInspection('FILE:///normalized.html');
    await api.injectViewMessage('FILE:///normalized.html', { type: 'viewEdited' });

    expect(lookups).toEqual([
      'inspection:file:///normalized.html',
      'session:file:///normalized.html',
    ]);
  });

  it('returns false without delegating to the save coordinator when disabled', async () => {
    let sessionReads = 0;
    const api = createTestSupportApi(createDependencies({
      enabled: false,
      findSession: () => {
        sessionReads += 1;
        return createSession();
      },
    }));

    const replaced = await api.replaceViewContentForTest('file:///document.html', '<p>changed</p>');

    expect([replaced, sessionReads]).toEqual([false, 0]);
  });

  it('returns false when the target session has no save coordinator', async () => {
    const session = createSession();
    const api = createTestSupportApi(createDependencies({
      findSession: () => ({ ...session, saveCoordinator: undefined }),
    }));

    await expect(
      api.replaceViewContentForTest('file:///document.html', '<p>changed</p>'),
    ).resolves.toBe(false);
  });

  it('passes a replacement only to the save coordinator and never to the view message dispatcher', async () => {
    const received: ViewToHostMessage[] = [];
    const replacements: string[] = [];
    const api = createTestSupportApi(createDependencies({
      findSession: () => createSession(received, replacements),
    }));

    const replaced = await api.replaceViewContentForTest(
      'file:///document.html',
      '<!DOCTYPE html><body><p>changed</p></body>',
    );

    expect([replaced, replacements, received]).toEqual([
      true,
      ['<!DOCTYPE html><body><p>changed</p></body>'],
      [],
    ]);
  });

  it('returns false without invoking the view message dispatcher when disabled', async () => {
    const received: ViewToHostMessage[] = [];
    const api = createTestSupportApi(createDependencies({
      enabled: false,
      findSession: () => createSession(received),
    }));

    const dispatched = await api.injectViewMessage('file:///document.html', { type: 'viewEdited' });

    expect([dispatched, received]).toEqual([false, []]);
  });

  it('returns false when there is no target session', async () => {
    const api = createTestSupportApi(createDependencies({ findSession: () => undefined }));

    await expect(
      api.injectViewMessage('file:///missing.html', { type: 'viewEdited' }),
    ).resolves.toBe(false);
  });

  it('passes the received message to the view message dispatcher unaltered', async () => {
    const received: ViewToHostMessage[] = [];
    const message: ViewToHostMessage = { type: 'viewEdited' };
    const api = createTestSupportApi(createDependencies({
      findSession: () => createSession(received),
    }));

    const dispatched = await api.injectViewMessage('file:///document.html', message);

    expect([dispatched, received[0] === message]).toEqual([true, true]);
  });

  it('delegates flushes to the canonically identified target session only when inspection is enabled', async () => {
    const lookups: string[] = [];
    const api = createTestSupportApi(createDependencies({
      normalizeDocumentUri: () => 'file:///normalized.html',
      findSession: (documentUri) => {
        lookups.push(documentUri);
        return createSession([], [], async () => true);
      },
    }));
    const disabled = createTestSupportApi(createDependencies({
      enabled: false,
      findSession: () => createSession([], [], async () => true),
    }));

    await expect(api.flushEditTransactionsForTest('FILE:///normalized.html')).resolves.toBe(true);
    await expect(disabled.flushEditTransactionsForTest(RECORDED_URI)).resolves.toBeUndefined();
    expect(lookups).toEqual(['file:///normalized.html']);
  });

  it('delegates the history drive hook to the target session by canonical form only while inspection is enabled', async () => {
    const lookups: string[] = [];
    const transitions: string[] = [];
    const api = createTestSupportApi(createDependencies({
      normalizeDocumentUri: () => 'file:///normalized.html',
      findSession: (documentUri) => {
        lookups.push(documentUri);
        return createSession([], [], async () => true, transitions);
      },
    }));
    const disabled = createTestSupportApi(createDependencies({
      enabled: false,
      findSession: () => createSession([], [], async () => true, transitions),
    }));

    await expect(api.runHistoryTransitionForTest('FILE:///normalized.html', 'undo'))
      .resolves.toBe(true);
    await expect(disabled.runHistoryTransitionForTest(RECORDED_URI, 'undo'))
      .resolves.toBeUndefined();
    expect(lookups).toEqual(['file:///normalized.html']);
    expect(transitions).toEqual(['undo']);
  });

  it('calls the backup entry point with a canonical-form URI only when enabled, and runs no inspection, backup request, or view control when disabled', async () => {
    const calls: string[] = [];
    const access: BackupTestAccess = {
      readBackupInspection: (documentUri) => {
        calls.push(`inspect ${documentUri}`);
        return { trackedBackupUri: 'memory:/backup', protectionStatus: undefined, protectionBackupUri: undefined };
      },
      readRestoreInspection: (documentUri) => {
        calls.push(`restore ${documentUri}`);
        return { progress: 'restored', adoptedBackupUris: ['memory:/backup'] };
      },
      requestBackupForTest: (documentUri, destinationUri) => {
        calls.push(`backup ${documentUri} ${destinationUri}`);
        return Promise.resolve({ id: 'memory:/backup', delete: () => undefined });
      },
      controlBackupViewForTest: (documentUri, operation) => {
        calls.push(`control ${documentUri} ${operation}`);
        return Promise.resolve(true);
      },
      prepareInitialReconcileForTest: () => undefined,
      saveTextEditorThenViewForTest: () => Promise.resolve(true),
    };
    const overrides = { normalizeDocumentUri: () => 'file:///normalized.html', backupAccess: () => access };
    const api = createTestSupportApi(createDependencies(overrides));
    const disabled = createTestSupportApi(createDependencies({ ...overrides, enabled: false }));

    const enabledResults = [
      api.readBackupInspection('FILE:///normalized.html')?.trackedBackupUri,
      api.readRestoreInspection('FILE:///normalized.html')?.progress,
      (await api.requestBackupForTest('FILE:///normalized.html', 'file:///backups/1'))?.id,
      await api.controlBackupViewForTest('FILE:///normalized.html', 'suspendOutputResponses'),
    ];
    const disabledResults = [
      disabled.readBackupInspection(RECORDED_URI),
      disabled.readRestoreInspection(RECORDED_URI),
      await disabled.requestBackupForTest(RECORDED_URI, 'file:///backups/1'),
      await disabled.controlBackupViewForTest(RECORDED_URI, 'suspendOutputResponses'),
    ];

    expect(enabledResults).toEqual(['memory:/backup', 'restored', 'memory:/backup', true]);
    // When disabled, the restricted backup access is not called, including for the restore inspection.
    expect(disabledResults).toEqual([undefined, undefined, undefined, false]);
    expect(calls).toEqual([
      'inspect file:///normalized.html',
      'restore file:///normalized.html',
      'backup file:///normalized.html file:///backups/1',
      'control file:///normalized.html suspendOutputResponses',
    ]);
  });

  it('passes the initial reconcile gate to the restricted backup access in canonical form only when enabled', () => {
    const prepared: string[] = [];
    const gate = { reached: Promise.resolve(), release: () => undefined };
    const access = {
      readBackupInspection: () => undefined,
      readRestoreInspection: () => undefined,
      requestBackupForTest: () => Promise.resolve({ id: 'memory:/backup', delete: () => undefined }),
      controlBackupViewForTest: () => Promise.resolve(true),
      prepareInitialReconcileForTest: (documentUri: string) => {
        prepared.push(documentUri);
        return gate;
      },
      saveTextEditorThenViewForTest: () => Promise.resolve(true),
    } satisfies BackupTestAccess;
    const overrides = { normalizeDocumentUri: () => 'file:///normalized.html', backupAccess: () => access };
    const api = createTestSupportApi(createDependencies(overrides));
    const disabled = createTestSupportApi(createDependencies({ ...overrides, enabled: false }));

    const enabledResult = api.prepareInitialReconcileForTest('FILE:///normalized.html');
    const disabledResult = disabled.prepareInitialReconcileForTest(RECORDED_URI);

    expect([enabledResult, disabledResult]).toEqual([gate, undefined]);
    expect(prepared).toEqual(['file:///normalized.html']);
  });

  it('runs the dirty text buffer notice action through the restricted backup access in canonical form only when enabled', async () => {
    const retried: string[] = [];
    const access = {
      readBackupInspection: () => undefined,
      readRestoreInspection: () => undefined,
      requestBackupForTest: () => Promise.resolve({ id: 'memory:/backup', delete: () => undefined }),
      controlBackupViewForTest: () => Promise.resolve(true),
      prepareInitialReconcileForTest: () => undefined,
      saveTextEditorThenViewForTest: (documentUri: string) => {
        retried.push(documentUri);
        return Promise.resolve(true);
      },
    } satisfies BackupTestAccess;
    const overrides = { normalizeDocumentUri: () => 'file:///normalized.html', backupAccess: () => access };
    const api = createTestSupportApi(createDependencies(overrides));
    const disabled = createTestSupportApi(createDependencies({ ...overrides, enabled: false }));

    const enabledResult = await api.saveTextEditorThenViewForTest('FILE:///normalized.html');
    const disabledResult = await disabled.saveTextEditorThenViewForTest(RECORDED_URI);

    expect([enabledResult, disabledResult]).toEqual([true, false]);
    expect(retried).toEqual(['file:///normalized.html']);
  });
});

/** Creates a minimal session that only records what the drive hooks reach. */
function createSession(
  received: ViewToHostMessage[] = [],
  replacements: string[] = [],
  flush: () => Promise<boolean> = async () => true,
  transitions: string[] = [],
): TestSupportSession {
  return {
    dispatchViewMessage: async (message) => {
      received.push(message);
      return true;
    },
    saveCoordinator: {
      replaceViewContentForTest: async (text) => {
        replacements.push(text);
        return true;
      },
    },
    editTransactionBridge: { flush },
    editHistoryCoordinator: {
      runHistoryTransitionForTest: async (direction) => {
        transitions.push(direction);
        return true;
      },
    },
  };
}
