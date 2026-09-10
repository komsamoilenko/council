# Public specification

## Scope and authority

This is the condensed normative contract for council 0.1.0 as implemented in
`src/` and `installer/`. It describes the shipped Windows behavior. macOS and
Linux have process/secrets/file-attribute stubs and refuse operations requiring
those capabilities. [INTERFACES](INTERFACES.md) defines public arguments and
results; [VERSIONS](VERSIONS.md) separates enforced floors from tested versions.
The Antigravity adapter is disabled; see [NOTICE](../NOTICE.md).

## Trust and process model

Z0 contains installer-managed code, Z1 local configuration and ownership
records, Z2 runtime scratch/secrets, and Z3 agent-writable vault data. Jobs and
ledger can live in the vault or be relocated to runtime storage. Z0/Z1 must
remain outside vault write grants. **Nothing agent-writable changes what runs.**
See [SECURITY-MODEL](SECURITY-MODEL.md) for threat assumptions and limits.

The stable launcher selects an installed version through `etc/current.json`
and runs its server as the main module. Each host owns a stateless stdio front
end; detached per-job runners own deadlines, heartbeat and finalization. Tool
results come from disk so hosts can share jobs within a profile.

Boot must verify installed profile trust and app integrity. Untrusted
configuration enters doctor-only mode. Executables and read paths must pass
lexical and resolved-root checks. The runner must validate mutable spawn
documents before execution. Child argv uses arrays without a shell; child
environments use the allowlist and fixed PATH. Gemini API proxy variables
are scoped to that backend. Secrets must not enter argv or job metadata.

Starts must enforce STOP, depth, prompt and shared leg-reservation limits.
Runners enforce wall time and cancellation. Identity must be checked before
tree kills; stale heartbeats alone do not prove a job is lost. Uncertain death
must be reported, not converted into successful cancellation. Terminal output
is untrusted data, and the renderer must preserve one final `NEXT:` line.

## Installer verbs

Invoke `bin\council-setup.cmd <verb> [flags]`, or
`node installer/setup.mjs <verb> [flags]`. Profile defaults to `default`.
Unknown/repeated flags and unexpected positional arguments are usage errors.
The full flag table and JSON variants are in [INTERFACES](INTERFACES.md).

| Verb | Contract |
|---|---|
| `detect` | Survey; write only explicitly requested reports |
| `plan` | Declare all writes and registrations; publish the external plan and requested duplicate report |
| `apply` | Validate the saved plan, confirm, journal writes, run Tier 0 before registration |
| `verify` | Check integrity/drift, isolated tests and direct stdio registrations |
| `update` | Stage and test git/zip source, publish a version, switch the current pointer; support rollback/pruning |
| `uninstall` | Remove only manifest-authorized content; retain modified/user content and backups by default |
| `install-prereqs` | Attended package-manager metadata and per-item install confirmation |
| `login` | Attended vendor login guidance, with no automated login or credential reads |
| `migrate` | Journal phases 0 through 3 of the generic legacy transition |
| `rollback` | Recover an identified journal while preserving conflicting edits |
| `set-key` | Validate and protect a Gemini API key, or confirm removal of that one key file |
| `duplicates` | Write a duplicate report; delete nothing |
| `new-task` | Create the named task folder and declared task files |
| `unlock` | Recover a stale setup lock; refuse live owners |

| Exit | Meaning |
|---|---|
| 0 | Success |
| 1 | Failed step |
| 2 | Usage or unmet precondition |
| 3 | Stale plan |
| 4 | Conflict |
| 5 | Open journal or declined operation-level confirmation |
| 6 | Unsupported platform |
| 7 | Verification drift |

Per-item prerequisite declines are choices and do not cause exit 5.
`install-prereqs` and `login` require a terminal. Key input can use stdin;
key deletion requires a terminal. Only verbs declaring `--yes` accept it;
it does not replace separate per-item purge decisions. Recovery directions
are in [INSTALL](INSTALL.md).

## Plans, journal and safe writes

Plans are external files with an input fingerprint, ordered S0-S11 steps,
per-path writes, registrations, warnings and untouched paths. Apply must
reject changed inputs with exit 3. A saved plan is not permission to execute
arbitrary code or write arbitrary paths: apply validates its scope and content.

Apply stages are preflight, lock/journal, backups, app, machine/profile,
runtime, vault, Tier 0, registration, manifest/shared skill, journal commit and
report. It downloads nothing. Durable journal records precede writes and
record their resulting state. Atomic sibling writes and rename publication
limit partial files. Open journals must be resumed with the same plan or
explicitly rolled back, not silently abandoned. A live lock cannot be stolen.

Recovery distinguishes the recorded pre-image, expected post-image and a
conflicting current image. It restores or completes only recognized states;
unrecognized user changes are retained and reported. A journal groups edits
for crash recovery; it does not make multiple host files one atomic OS write.

## Manifest, markers and backups

The external profile manifest records ownership, hashes, created status,
registrations, pre-existing entries and backup paths. Removal verbs are
`excise_block`, `delete_if_hash_matches`, `rmdir_if_empty`,
deletion of a host key only when its entry hash matches,
`restore_pre_existing_entry`, `never`, and `never_while_profile_exists`.
The host-key deletion identifier joins `delete_key_if_` and `entry_hash_matches`.
A path in a manifest alone is not enough:
removal must also pass recomputed scope, link, ownership and current-state checks.
The shared skill is reference-counted across profiles.

Every pre-existing file edited by apply is backed up whole under
`etc/backups/<profile>/<timestamp>`, including host configuration. Owner ACL
restriction must be attempted and readability checked. ACL failure is a
reported warning, not evidence of successful restriction. Uninstall recovers
host entries surgically; it must not restore an old whole-file backup over
unrelated current host entries. Backups remain unless explicitly purged with
the applicable per-item confirmation.

Vault merges preserve BOM, dominant EOL and bytes outside a managed block,
with a post-write assertion. The canonical markdown begin marker is
`<!-- council:begin v=1 -->`; unversioned markdown and hash-comment forms are
accepted as version 1. Duplicate, unbalanced or unknown-version blocks cause
conflicts. Hashes belong in the external manifest, not the marker. Details
and the two conditional rules flags are in [VAULT-CONTRACT](VAULT-CONTRACT.md).

Removal is limited to explicit manifest operations, narrowly recorded
transient files, and explicit protected-key deletion. Normal operation must
not prune notes, jobs or ledger history. Reparse points do not expand scope.

## Host registration

All hosts name an absolute Node executable with one argument, the absolute
stable `bin/council-server.js` launcher. Environment entries are
`COUNCIL_HOST` and `COUNCIL_PROFILE`, never a secret or executable path.
No `npx`, shell wrapper or `.cmd`/`.bat`/`.ps1` registration is accepted.

| Host | Shape and editing rule |
|---|---|
| Claude Code | User-scope stdio `mcpServers` entry, primarily via `mcp add-json`, with readback |
| Claude Desktop | One JSON `mcpServers` key, preserving neighboring entries; full restart required |
| Codex | Marked `[mcp_servers.<name>]` TOML table with command, args, `tool_timeout_sec = 60`, and an env subtable |

Installer paths honor `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `APPDATA` where
applicable. The runtime's diagnostic path resolver does not honor the first
two identically; direct installer verification is the registration check.
Absent hosts remain pending. Existing names require compatible ownership or
explicit adoption, never an unrelated server overwrite. Direct initialize/
doctor probes prove the server round trip, not the host's reload behavior.

## Tests and release gate

`node tests/run.mjs` imports the release-tool regressions (which also import
the scanner regressions), then runs Tier 0, installer unit, installer
integration and trust suites. Any regression failure or suite failure makes
the gate nonzero. The four child suites run even if an earlier child fails.

Tier 0 exercises the runtime using echo and isolated profiles. Installer unit
tests cover pure transformations; integration tests use fake vendor probes
and redirected host/profile paths. Trust tests exercise execution and write
boundaries. `node tests/tier0/lint.mjs` includes T-24 boundary/template lint
and T-27 scanning. `node tools/scan-personal.mjs` must report zero hits, with
no file exemptions. Skips are reported separately and do not prove coverage.
No vendor quota is required. Hosted CI is limited to static/pure checks.
Tiers 1 and 2 are manual vendor/host checks: instructions are printed, never
automatically run by the zero-quota gate.

The public release tree is the tracked tree at a clean commit. Staging runs
the gate and scans before and after writing local evidence. Releases are tags
on the existing repository; the zip and checksum are assets, while the staging
inventory is local evidence. See [RELEASING](RELEASING.md).
