# Changelog

All notable changes are documented here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

See [release notes](docs/release-notes/0.1.0.md) for release scope and limitations,
including the Node 24 test evidence and the unverified older launcher floor.
