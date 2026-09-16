# Changelog

All notable changes are documented here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `update` could not run on any installation: it reads its channel from
  `machine.json.source`, and nothing wrote that field. `apply` now records it from the
  tree the installer ran from — a git clone's worktree, or the repository's fixed-name
  `council-latest.zip` for an extracted release — and never overwrites a `source` set by
  hand. An existing installation gets the field on its next `plan --hosts none` + `apply`.
- The release archive is built outside the repository. The personal-data scanner reads the
  whole working tree without exemptions, so a zip or sha256 sidecar built inside it failed
  T-27 and blocked the next staging; RELEASING.md now builds under the system temp directory.
- The account-name rule of the personal-data scanner matches a whole word. Every path, host
  and address form still trips it; the repository owner's public handle, which merely begins
  with the same letters, no longer does, so `package.json` can name the repository.

### Changed

- Every release attaches `council-latest.zip` and its `.sha256` beside the versioned pair,
  so that zip installs can update through `releases/latest/download`.
- `package.json` names the repository and homepage.

## [0.1.1] - 2026-09-15

### Fixed

- Codex is probed at the `exec` subcommand, which is where `--ignore-user-config`,
  `--ignore-rules` and `--skip-git-repo-check` are accepted and where the backend
  passes them. Detection no longer marks a working Codex unusable, and records which
  of the three flags a build accepts.
- `machine.json` carries every key its template declares: the Codex path, the
  ripgrep vendored beside it, the Gemini API helper, the write time, the detected
  versions and the NOTICE acknowledgement. Vault search no longer refuses on an
  installation that has ripgrep available.
- `verify` compares the installation against what detection finds. A usable CLI
  with no corresponding entry, a ripgrep detection located but the installation
  lacks, or a backend the running server calls unavailable are reported as drift
  instead of passing in silence. Planning with no hosts and applying that plan
  repairs an existing installation.
- The vault survey walks with `lstat` instead of spawning an attribute probe per
  directory, which took minutes on a vault of a few thousand directories. The
  attribute probe is kept where a write target is decided.
- A directory the account cannot read is a warning naming the subtree rather than a
  refusal, except for the paths the installer must read or write.
- Migration recognises the registration it replaces by parsed value, so a Codex
  table written by hand — a TOML literal string, the ordinary way to spell a Windows
  path — is adopted in place. A table naming a different server is still refused.
- The personal-data scanner finishes on a pathological file instead of exhausting
  the stack, and reports an unscannable file as a finding with its reason.
- The pre-migration store-shape check compares the persisted shape only, not a reader.

### Changed

- The file count that guards against an accidentally broad vault root excludes
  `.git`, `node_modules`, the job store and the ledger, and the report names those
  exclusions with their counts. Migration passes the acknowledgement itself, since
  it did not choose the vault by hand.
- The application version is stated once, in `src/version.js`. The installer reads
  it rather than restating it, and the lint requires every version literal in the
  source, templates and documents to equal it. A bump is `src/version.js` and
  `package.json`, which the Tier-0 suite and release staging each refuse to see
  disagree.
- Vendored ripgrep is located through the platform layer rather than a literal.
- A template that a released installer renders may only use the values that
  installer already supplies, because an update renders the new release's templates
  with the installer the user already has.

## [0.1.0] - 2026-09-10

### Added

- Eight MCP tools for consultations, polling, blocking asks, cancellation,
  job listing, vault search, diagnostics and ledger inspection.
- Claude Code, Codex and Gemini API legs, with echo for zero-quota testing.
- Windows platform implementation, stable launcher, detached job supervision,
  process identity checks, tree cancellation and cancellation timing diagnostics.
- External machine/profile configuration, multiple vault profiles, path tokens,
  relocatable jobs/ledger, narrow executable roots and app integrity checks.
- Environment allowlisting, redaction, shared fuses, STOP files and a local
  append-only usage ledger. Gemini API child transport uses a stdin secret
  header, scoped proxies and Windows DPAPI key storage.
- All fourteen installer verbs: `detect`, `plan`, `apply`, `verify`, `update`,
  `uninstall`, `install-prereqs`, `login`, `migrate`, `rollback`, `set-key`,
  `duplicates`, `new-task` and `unlock`.
- Journalled writes/recovery, hash manifests, marked block merges, whole-file
  backups, surgical host-entry recovery, duplicate reports and vault/cloud checks.
- Claude Code, Claude Desktop and shared Codex registration; conditional English
  vault templates and a reference-counted shared setup skill.
- Git/zip update channels and generic migration preserving existing history.
- Zero-quota runtime, installer and trust suites; boundary/template lint;
  exemption-free personal-data scanning and scanner/release-tool regression wiring.
- Tracked-tree release staging for clean commits, tag-based release instructions,
  zip/checksum tooling, public documentation and release notes.

### Changed

- macOS/Linux explicitly report unsupported process/secrets/file-attribute
  capabilities; diagnostic reads and terminal results remain available.

### Security

- The Antigravity adapter ships disabled; see [NOTICE](NOTICE.md).
- Host registration names an absolute Node executable and stable launcher,
  with no command shim or secret-bearing environment entry.

### Deferred

- macOS/Linux process, secrets and file-attribute implementations (planned for v0.2).
- npm publication; GitHub Actions beyond lint; Gemini multi-turn resume; a GUI.
- Router/debate-protocol changes and measured Codex/Antigravity version floors;
  Antigravity remains disabled, see [NOTICE](NOTICE.md).
- Claude Code project-scope registration and first-class MSIX Desktop writes.
- Signed releases, pinned-binary-hash mode and automatic rules-block translation.

See [release notes](docs/release-notes/0.1.1.md) for release scope and limitations,
including the Node 24 test evidence and the unverified older launcher floor.
