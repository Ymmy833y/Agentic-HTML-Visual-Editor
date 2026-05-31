// Shared context passed to every editing command. Kept in its own module so
// command implementations (commands/, features/) can depend on the type
// without importing each other — it used to live in commands.ts, which turned
// that file into an accidental hub.

export interface CommandContext {
  root: HTMLElement;
}
