export { MESSAGE_KEYS } from './i18n/message-key';
export type { MessageKey } from './i18n/message-key';
export {
  MESSAGE_CATALOG_ELEMENT_ID,
  parseMessageCatalog,
} from './i18n/message-catalog';
export type { MessageCatalog, MessageParams } from './i18n/message-catalog';
export { createLocalizer, resolveMessage } from './i18n/resolve-message';
export type { Localizer } from './i18n/resolve-message';
export {
  DOCUMENT_APPLY_KIND,
  DOCUMENT_APPLY_OUTCOME,
  HOST_TO_VIEW_MESSAGE_TYPE,
  RESTORE_ACTION,
  RESTORE_FAILURE_CAUSE,
  VIEW_TO_HOST_MESSAGE_TYPE,
} from './messaging/message';
export type {
  BodyOutputResponseMessage,
  CodeBlockCopyRequestedMessage,
  CodeBlockCopySucceededMessage,
  ConflictSides,
  ConflictsResolvedMessage,
  CopyHtmlResponseMessage,
  CopyRequestedMessage,
  CopySucceededMessage,
  DirtyStateMessage,
  DocumentApplyKind,
  DocumentApplyOutcome,
  DocumentInitializedMessage,
  DocumentReplacedMessage,
  EditTransactionFlushResultMessage,
  EditTransactionMessage,
  EditUnitStartMessage,
  EditUnitUnchangedMessage,
  HistoryProtectionActivatedMessage,
  HostToViewMessage,
  InitializeMessage,
  PresentConflictsMessage,
  RelativeLinkRequestedMessage,
  ReplaceDocumentMessage,
  ReplaceCurrentDocumentMessage,
  ReplaceEditHistoryMessage,
  RequestEditTransactionFlushMessage,
  RequestBodyOutputMessage,
  RequestCopyHtmlMessage,
  RestoreAction,
  RestoreActionSelectedMessage,
  RestoreCompletedMessage,
  RestoreFailedMessage,
  RestoreFailureCause,
  SaveCommittedMessage,
  SaveReleasedMessage,
  SaveRequestedMessage,
  SidebarLayoutChangedMessage,
  UnsavedContentMessage,
  ViewDiagnosticMessage,
  ViewEditedMessage,
  ViewReadyMessage,
  ViewToHostMessage,
} from './messaging/message';
export { EDIT_UNIT_SIGNAL_KIND } from './history/edit-transaction';
export type {
  EditSnapshot,
  EditTransaction,
  EditUnitId,
  EditUnitSettledSignal,
  EditUnitSignal,
  EditUnitStartSignal,
  EditUnitUnchangedSignal,
  EncodedPosition,
  EncodedSelection,
} from './history/edit-transaction';
export {
  HISTORY_DIRECTION,
  HISTORY_TRANSITION_REJECTION,
  decideHistoryTransition,
  findRecordedEditRange,
  matchesIgnoringLineEndings,
} from './history/history-transition';
export type {
  HistoryDirection,
  HistoryTransitionCandidate,
  HistoryTransitionInput,
  HistoryTransitionRejected,
  HistoryTransitionRejection,
  HistoryTransitionResult,
} from './history/history-transition';
export { DOCUMENT_REPLACE_TIMEOUT_MS, RESPONSE_TIMEOUT_MS } from './messaging/request';
export type {
  RequestFailure,
  RequestId,
  RequestMessage,
  RequestOutcome,
  ResponseMessage,
} from './messaging/request';
export { discardUnhandledMessage } from './messaging/unhandled-message';
export {
  BACKUP_TEST_OPERATION,
  TEST_MESSAGE_TYPE,
  TEST_MODE_META_NAME,
} from './messaging/test-message';
export type {
  BackupTestOperation,
  TestHostToViewMessage,
  TestViewToHostMessage,
} from './messaging/test-message';
export { EDITOR_ROOT_ELEMENT_ID } from './view/editor-root';
export {
  DEFAULT_SIDEBAR_LAYOUT,
  SIDEBAR_LAYOUT_META_NAME,
  SIDEBAR_MIN_WIDTH,
  parseSidebarLayout,
} from './view/sidebar-layout';
export type { SidebarLayout, SidebarLayoutChange } from './view/sidebar-layout';
export {
  ALLOWED_TAG_NAMES,
  DANGEROUS_URL_SCHEMES,
  EVENT_HANDLER_ATTRIBUTE_PREFIX,
  FORBIDDEN_TAG_NAMES,
  PASTE_STYLE_ALLOWLIST,
  SRCSET_ATTRIBUTE_NAME,
  URL_ATTRIBUTE_NAMES,
} from './html/html-contract';
export { ALERT_ATTRIBUTE_NAME, ALERT_KINDS } from './html/alert-kind';
export type { AlertKind } from './html/alert-kind';
export {
  COMMENT_ATTRIBUTE,
  COMMENT_AUTHOR,
  COMMENT_BODY_MAX_COUNT,
  COMMENT_ENTRY_EDITABLE_VALUE,
  COMMENT_ENTRY_ORDER,
  COMMENT_ID_FORMAT,
  COMMENT_TAG_NAME,
} from './html/comment-annotation';
export type { CommentAuthor } from './html/comment-annotation';
export { CHANGE_ATTRIBUTE, CHANGE_AUTHOR, CHANGE_KIND } from './html/change-mark';
export type { ChangeKind } from './html/change-mark';
export { isBlankDocument, joinDocument, splitDocument } from './html/document-boundary';
export type { DocumentBoundary } from './html/document-boundary';
export { rewriteCharsetDeclaration } from './html/charset-declaration';
export { joinLines, splitLines } from './text/lines';
export {
  detectLineEnding,
  normalizeLineEndings,
  restoreLineEndings,
} from './text/line-ending';
export type { LineEnding } from './text/line-ending';
export { diffLines } from './text/line-diff';
export type { LineDiffSegment, LineRange } from './text/line-diff';
export { CONFLICT_CHOICE, flattenMergeRegions, mergeThreeWay } from './text/three-way-merge';
export type {
  ConflictChoice,
  ConflictRegion,
  MergeRegion,
  MergeResult,
  StableRegion,
} from './text/three-way-merge';
export { decideRestoreMount } from './backup/restore-mount';
export type {
  RestoreMountDecision,
  RestoreMountInput,
  RestoreProgress,
} from './backup/restore-mount';
export { isRelativeFileHref, trimHref } from './link/relative-href';
export { createLineMapping, mapToDisk } from './text/line-mapping';
export type { LineMapping, LineMappingSegment } from './text/line-mapping';
export { buildBodyOutput } from './text/body-output';
