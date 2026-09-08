<!-- Owns changelog documentation; specification §§2–6,14. -->
# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project will use
[semantic versioning](https://semver.org/spec/v2.0.0.html) from its first release.

## [Unreleased]

Nothing is installable yet. This section will say when that changes.

### Added
- Repository scaffolding: README, LICENSE (MIT), NOTICE, SECURITY, CONTRIBUTING and the
  architecture notes.

### Design decided, not yet implemented
- Repository layout, module boundaries and the platform layer.
- Per-machine configuration outside the vault; a launcher stub so an update does not
  touch host configuration files.
- The installer: `detect`, `plan`, `apply`, `verify`, `uninstall`, `update`, with a
  journal, a hash manifest, marker-block merges, dated backups, a duplicate report and a
  cloud-sync warning. Adopts an existing folder in place.
- Host registration for Claude Code, Claude Desktop, and Codex (CLI, desktop app and
  VS Code extension, which share one configuration file).
- The Gemini leg over the API with a DPAPI-protected key; the Antigravity adapter present
  but disabled and gated, as described in NOTICE.md.
- Test plan: the zero-quota suite ported, plus trust-boundary tests and an installer
  suite that runs against a temporary home directory and fixture vaults.
