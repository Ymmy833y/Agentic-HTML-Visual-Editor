import { defineConfig } from 'vitest/config';

// Unit layer configuration.
// The default environment is jsdom because the webview edge cases this layer covers need a DOM.
// Tests on the common side switch to the node environment with a file-level directive, which shows
// that common runs without a DOM (C-CMN-04).
export default defineConfig({
  test: {
    environment: 'jsdom',
    // The e2e layer uses *.spec.ts; the layers are split by extension so neither picks up the other's files.
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'common/**/*.ts',
        'webview/**/*.ts',
        'src/security/nonce.ts',
        'src/security/content-security-policy.ts',
        'src/editor/webview-content.ts',
        'src/i18n/message-resource-loader.ts',
        'src/messaging/pending-requests.ts',
        'src/history/edit-transaction-validation.ts',
        'src/history/edit-transaction-bridge.ts',
        'src/history/edit-unit-tracker.ts',
        'src/history/history-state.ts',
        'src/history/edit-history-coordinator.ts',
        'src/history/history-availability.ts',
        'src/diagnostics/error-reporter.ts',
        'src/editor/view-message-handler.ts',
        'src/editor/html-custom-document.ts',
        'src/editor/editor-resource.ts',
        'src/editor/editor-switch.ts',
        'src/link/link-path.ts',
        'src/link/relative-link-opener.ts',
        'src/session/session-registry.ts',
        'src/clipboard/copy-as-html.ts',
        'src/save/document-operation-queue.ts',
        'src/save/save-coordinator.ts',
        'src/save/buffer-follow.ts',
        'src/save/document-sync-state.ts',
        'src/save/save-merge.ts',
        'src/backup/backup-content.ts',
        'src/backup/backup-store.ts',
        'src/backup/backup-coordinator.ts',
        'src/backup/recovery-coordinator.ts',
        'src/backup/restore-record-store.ts',
        'src/backup/restore-candidate.ts',
        'src/backup/restore-coordinator.ts',
        'src/backup/backup-discarder.ts',
        'src/testing/test-support-api.ts',
        'src/testing/webview-inspection.ts',
        'src/testing/save-entry-inspection.ts',
      ],
    },
  },
});
