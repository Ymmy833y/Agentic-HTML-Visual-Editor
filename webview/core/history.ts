import type { SavedSelection } from './selection';

export interface HistorySnapshot {
  html: string;
  selection: SavedSelection | null;
}

export interface HistoryEdit {
  before: HistorySnapshot;
  after: HistorySnapshot;
  label: string;
}

type InputGroup = 'typing' | 'backspace' | 'delete' | null;

const GROUP_DELAY_MS = 1000;

/**
 * Turns native input events and direct DOM commands into explicit editor
 * transactions. VS Code owns the actual undo stack; this class only decides
 * where one edit ends and the next begins.
 */
export class HistoryCoordinator {
  private current: HistorySnapshot | null = null;
  private pending: {
    before: HistorySnapshot;
    after: HistorySnapshot;
    group: Exclude<InputGroup, null>;
    label: string;
  } | null = null;
  private timer: number | null = null;

  constructor(
    private readonly capture: () => HistorySnapshot | null,
    private readonly commit: (edit: HistoryEdit) => void,
  ) {}

  public reset(snapshot?: HistorySnapshot | null): void {
    this.cancelTimer();
    this.pending = null;
    this.current = snapshot ?? this.capture();
  }

  /** Record a browser-performed input after its DOM mutation has completed. */
  public recordNative(inputType: string): void {
    const after = this.capture();
    if (!after) return;
    const group = inputGroup(inputType);
    if (!group) {
      this.flush();
      this.commitImmediate(after, inputLabel(inputType));
      return;
    }

    if (this.pending && this.pending.group === group) {
      this.pending.after = after;
    } else {
      this.flush();
      if (!this.current) {
        this.current = after;
        return;
      }
      this.pending = {
        before: this.current,
        after,
        group,
        label: inputLabel(inputType),
      };
    }
    this.scheduleFlush();
  }

  /** Record a direct DOM mutation after the command has completed. */
  public recordCommand(label = 'Edit WYSIWYG content'): void {
    const after = this.capture();
    if (!after) return;
    // pending.after was captured by the last native input and therefore does
    // not include this command. Commit it first to keep the boundaries exact.
    this.flush();
    this.commitImmediate(after, label);
  }

  public flush(): void {
    this.cancelTimer();
    const edit = this.pending;
    if (!edit) return;
    this.pending = null;
    if (edit.before.html !== edit.after.html) this.commit(edit);
    this.current = edit.after;
  }

  private commitImmediate(after: HistorySnapshot, label: string): void {
    const before = this.current;
    this.current = after;
    if (!before || before.html === after.html) return;
    this.commit({ before, after, label });
  }

  private scheduleFlush(): void {
    this.cancelTimer();
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, GROUP_DELAY_MS);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }
}

function inputGroup(inputType: string): InputGroup {
  if (inputType === 'insertText' || inputType === 'insertCompositionText') return 'typing';
  if (inputType === 'deleteContentBackward') return 'backspace';
  if (inputType === 'deleteContentForward') return 'delete';
  return null;
}

function inputLabel(inputType: string): string {
  if (inputType.startsWith('delete')) return 'Delete content';
  if (inputType === 'insertParagraph' || inputType === 'insertLineBreak') return 'Insert paragraph';
  if (inputType.includes('Paste')) return 'Paste';
  return 'Type text';
}
