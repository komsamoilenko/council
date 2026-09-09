<!-- Owns changelog documentation; specification §§2–6,14. -->
# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project will use
[semantic versioning](https://semver.org/spec/v2.0.0.html) from its first release.

## [Unreleased]

### Added
- Runtime port under `src/`, with per-machine configuration, launcher support,
  Windows process identity checks and tree cancellation.
- Initial installer verbs: `detect`, `plan`, `duplicates`, and `new-task`,
  with their explicit report, plan and task-file outputs.
- `apply` with a journal, hash manifests, backups and marker-block merges.
- Registration in Claude Code, Claude Desktop and the shared Codex configuration.
- `rollback` and stale setup-lock recovery with `unlock --force-unlock`.
- Four test suites: Tier 0 zero-quota smoke, installer unit, installer integration,
  and trust-boundary/portability tests.
- Cancellation diagnostics in the response and ledger, including helper timings,
  death-poll counts and durations, and runner-side kill timings.

### Pending
- `verify`, `update`, `uninstall`, `install-prereqs`, `login`, `migrate`, and `set-key`.
