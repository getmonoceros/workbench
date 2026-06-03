// Ambient module augmentation: add Monoceros-specific fields to
// citty's CommandMeta so command files can declare them inline
// without `as any` casts. Read in help.ts when grouping the
// COMMANDS section of `--help` output.
declare module 'citty' {
  interface CommandMeta {
    /**
     * Logical bucket the command belongs to for the grouped
     * `monoceros --help` output. See `GROUPS` in help.ts for the
     * recognised keys. An unknown or missing value lands in
     * "Other".
     */
    group?: string;
    /**
     * When true, the command is omitted from the grouped
     * `monoceros --help` COMMANDS block (it still runs if invoked
     * directly). Used for internal plumbing (`__complete`) and
     * install-script-only commands (`completion`).
     */
    hidden?: boolean;
  }
}

export {};
