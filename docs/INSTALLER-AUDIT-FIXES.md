# Task 08 audit decisions

`canonicalBlock` owns unwrapping an already marked template. A valid scanned block
contributes its inner body; template ownership comments outside it are not installed.
The template documents this contract too. Invalid proposals are scanned and returned
as exit-4 refusals before any block access. The regression reads the real template.

An unclosed Markdown fence refuses the file with `E_MARKER_FENCE_UNTERMINATED`
(exit 4), whether it precedes or follows an existing block. No replacement or append
is published. Closed fences continue to hide example markers.

Arbitration records pid, creation time and a unique token in its claim directory.
Recovery requires 30 minutes and confirmed death; unknown liveness requires the
explicit `node installer/setup.mjs unlock --force-unlock` escape. Live owners and
recent claims remain refused even with force. Refusals include the exact recovery
path, and unknown stale owners include their recorded metadata and escape flag.
Recovery happens before attempting to acquire the abandoned guard. Empty or torn
claim records from a crash require force after the age threshold; unexpected contents
and links remain manual refusals. No recursive removal is used by lock recovery.
The acquisition API also accepts `forceUnlock: true` for future writing verbs.

Safe writes retry publication separately from guard cleanup. Cleanup failures are
returned in `warnings` and emitted through `onWarning` (process warning by default),
including the exact guard path; they never cause a second rename. A close is attempted
once and cannot skip temp cleanup. Existing POSIX mode bits are restored independently
of umask; new files default to 0600. Every POSIX publication fsyncs its parent directory,
including journal and manifest writes. Windows Node lacks portable directory fsync,
so rename durability against power loss remains a documented platform limitation.

All eight numbered regressions failed against the pre-fix modules (91 existing tests
passed). Additional tests cover refusal boundaries and permanent cleanup failures.
The system-temp installer sandbox is removed in the parent's finally block, including
fixture setup failures and child failures. `--exercise-failure-cleanup` intentionally
fails a fixture, verifies its sandbox was removed, and exits 1.

No further specification question is open. The explicit unlock command is the narrow
A-03 recovery operation; the other future writing verbs remain unimplemented.
