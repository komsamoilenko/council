# Versions and compatibility

## Node and platform

The installer enforces Node **20.11.0** as its minimum and warns below 24.
The recorded runtime and launcher test version is **24.11.1**. The launcher
has not been established on the older floor; use Node 24 for the tested path.
This is a compatibility statement about this build, not a claim that 24.11.1
is the latest Node release. Application version is 0.1.0; configuration schema
is 2, contract and manifest schemas are 1.

Windows implements process supervision, secrets and file attributes. macOS
and Linux provide stubs and unsupported-platform diagnostics; see [PLATFORMS](PLATFORMS.md).

## CLI checks

| Component | What detection checks | Compatibility claim |
|---|---|---|
| Claude Code | A unique executable, `--version`, parsed version at least 2.1.263 | Older versions are marked unusable and receive an upgrade warning |
| Codex | Unique executable or Node entry point, parsed `--version`, `--help` advertising `--ignore-user-config`, and successful `--ignore-user-config --version` | Minimum version unknown, found X; the required flag is probed rather than inferred from a version floor |
| Antigravity (`agy`) | Reports discovered version and a help capability probe | Minimum version unknown, found X; always disabled in detection; see [NOTICE](../NOTICE.md) |
| Git | `git --version` | Availability and observed version, no measured minimum |
| npm | Node-adjacent `npm-cli.js`: global prefix, global root and version | Observed version and paths, no measured minimum |
| Ripgrep | Runtime doctor checks the configured executable and, with `deep`, `--version` | Required for search, no measured minimum |
| Gemini API | Runtime availability of the supported API configuration/key | No Gemini CLI version requirement |

Here X means the version actually reported on your installation, not a sample
version or a guaranteed supported floor. Missing or unparseable versions stay
unknown. Command shims are refused and ambiguous executable candidates are
reported as conflicts. Claude Desktop bundled CLI candidates are reported as
found but not usable by 0.1.0.

## Reading detect and doctor

`detect --json` emits named `blocks`: Node has `path`, `version`, `floor`;
`clis.clis` entries have `path`, `candidates`, `version`, `usable` and `disabled`,
with capability fields where probed. Warnings explicitly identify unverified
version floors. Human output presents the same facts, not a blanket compatible
label. Credential existence and login status are separate from version support.

`council_doctor {"deep":true}` runs version probes only in normal trusted mode;
it makes no model call. A successful version command is not a successful
consultation or proof of sign-in. See [INTERFACES](INTERFACES.md) for the report
shape and [INSTALL](INSTALL.md) for prerequisite guidance.
