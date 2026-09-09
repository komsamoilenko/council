# Verify, uninstall and update

`node installer/setup.mjs verify` checks installed app hashes, profile trust,
registrations and ownership hashes. It runs Tier-0 on an isolated temporary
profile, then initializes each registered server on its actual profile, lists
tools and calls doctor. These boots set `COUNCIL_SMOKE_RUN=1` and
`COUNCIL_LEDGER_PREFIX=verify-`. They prove the server, not host wiring. Ledger
names are reserved exclusively and cleaned by their recorded identities; an
existing verify file is preserved and reported. Drift exits 7. `--full` runs
the full Tier-0 selection. ACL inspection is read-only; unconfirmed backup ACL
restriction is a warning, never an attempted repair.

`uninstall` requires a terminal. Its report includes the complete structural
scope pass, removals and skipped paths. Registrations are removed surgically,
then blocks are excised and manifest-authorized files and empty directories
removed. Changed files, runtime data, backups, and protected gate/sandbox
paths stay in place. Shared application files stay while another profile
references them. `--keep-app`, `--keep-vault` and `--all` are supported.
An appended separator outside a marker remains outside the deletion range.
An existing transplant pointer with removal `never` remains installed.

`--purge-runtime` reviews secrets, relocated jobs and relocated ledger
separately. `--purge-backups` reviews each backup timestamp separately.
Each item passes the scope check before listing; every item gets its own
answer, followed by typing the profile ID. Declining an item preserves it.
Both flags refuse `--yes` and non-terminal input or output. Purges compare
the reviewed inventory again before deleting it. A backup is never an input
to uninstall recovery.

`update` resolves `machine.json.source`. Supported source shapes are:

```json
{"channel":"git","worktree":"<absolute worktree>","ref":"HEAD"}
```

```json
{"channel":"zip","asset":"<absolute zip or HTTPS release asset>"}
```

A ZIP uses its adjacent `.sha256`, or an explicit `sha256_file` /
`sha256_url`. Digest validation and archive path validation precede staging.
Git refs resolve to a commit before reading the tree; the worktree is not
checked out or modified. `--channel`, `--ref` and `--check` are supported.

The staged application and its hash manifest are validated by Tier-0.
Any profile with a running job blocks promotion. `current.json` is published
atomically, and the previous application stays installed. A failed stage
is retained as evidence. Schema changes merge new template defaults while
preserving existing values and take a config backup. Contract changes replace
only unchanged owned blocks; edited blocks get a new proposal and a diff.
A changed NOTICE requires terminal acknowledgement. Ownership hashes are
carried forward after migration. Host configuration files are not rewritten.

`update --rollback` restores the exact previous `current.json` bytes and
nothing else; it does not reverse config or contract migrations. Version
pruning requires a readable process command-line inventory, rejects referenced
versions and removes only individually manifested, hash-matched paths.
Unknown process visibility refuses pruning. `--keep N` must be at least one.
