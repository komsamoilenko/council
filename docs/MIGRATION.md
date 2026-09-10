# Moving an existing in-vault installation

Run these commands yourself in an interactive terminal. Snapshot the vault using
your own version-control workflow first. The installer never commits your files.
Use the same profile throughout and keep the previous installation in place.

1. `council-setup migrate --from "<vault>\bin\council" --phase 0`
   installs beside it with merge and hosts set to none. The only vault publication
   is `.council\vault.json`. Application files, runtime directories and local
   configuration go under the local council root. The shared skill is also written
   at `<CLAUDE_CONFIG_DIR or home\.claude>\skills\council-setup\SKILL.md` in S9.
   Jobs stay in `work/jobs`; ledger and fuse history stay in `ledger`.
2. `council-setup migrate --phase 1` verifies the installation, then plans and
   confirms the second Claude Code registration, `council-next`. Compare the two
   doctors and run an echo consultation through `council-next`; this costs no quota.
3. Cut over one host per command, in this order:

   ```text
   council-setup migrate --phase 2 --host codex
   council-setup migrate --phase 2 --host claude-desktop
   council-setup migrate --phase 2 --host claude-code
   ```

   Each step prints its writes and asks for confirmation. Each host file gets a
   dated whole-file backup for human inspection. Recovery uses only the recorded
   server entry or exact TOML table; no host file is restored whole. Restart Desktop
   when convenient. Running sessions keep their already-spawned server.

   A working server remains registered under `council`, or transiently under
   `council-next`. Claude Code removes the old primary entry, adds the new primary,
   and removes the second entry last. Host and manifest removal are journalled
   together: both or neither is a **post-recovery** guarantee, not an instantaneous
   two-file publication guarantee. All intents precede the first host edit.

   An interrupted step is reported by `detect`. Resume its printed plan using
   `apply --plan <file> --resume`, or use `rollback --journal <timestamp>` to undo
   that step. `migrate --rollback` recovers an interrupted migration; otherwise it
   re-points migrated entries at their recorded previous registrations. Recovery
   refuses human edits and preserves unrelated host content.
4. `council-setup migrate --phase 3` records and writes `FROZEN.md` in the old
   directory. It prints the retained leftovers for individual decisions and deletes
   nothing. Keep both trees for a week before deciding about the frozen copy.

Before cutover, `migrate --phase 2 --host claude-code --rollback` removes only the
side-by-side registration. A general rollback retains the installed application,
shared skill, runtime and any frozen snapshot. It never kills a running job or
rewrites a job, ledger row or fuse history. `--dry-run` publishes nothing.

Automatic migration compares the persisted job layout, job reader, append and lock
primitives, ledger row head, requester shape and month-file reader against this build.
It ignores source comments and formatting and never executes the old source during
that comparison. Store paths must match the defaults above. Different shapes or
layouts require review; they are not silently assumed compatible.

Antigravity is outside this procedure. Any unavailable-adapter diagnostic contains
only the doctor's reason and a pointer to NOTICE.md.
