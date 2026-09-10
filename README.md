# council

Council is a local MCP server that lets the assistant you are talking to consult
another vendor's assistant through your own CLIs and Gemini API key. It runs
consultations as durable background jobs, returns independently produced
answers for you and your assistant to assess, and records usage in a local ledger.

```text
Claude Desktop / Claude Code / Codex app or extension
  -> stable launcher -> stdio MCP server per host
                          -> detached runner per job
                               -> Claude / Codex / Gemini API / echo
                          <- results on disk <- council_poll
```

## Status

Version 0.1.0 implements eight tools, the complete installer command set,
three host registrations, multiple profiles, journalled recovery, git/zip
updates and manifest-based uninstall. Windows is implemented. macOS/Linux
ship stubs: diagnostics and permitted reads work, but starting consultations,
active polling and cancellation require implemented process supervision.
Terminal results remain readable. See [CHANGELOG](CHANGELOG.md).

## What it is not

Council is not a hosted service, chat UI, account switcher or shared-subscription
service. It ships no vendor CLI and does not automate vendor login. An agreement
between assistants is not proof: check the shared claim before calling it
verified. Read [NOTICE](NOTICE.md) before using third-party services.

## Requirements

Windows, Node 20.11 or newer, and the vendor CLI/account or Gemini key for the
legs you use. Node 24 is the tested path; the launcher on the older enforced
floor remains unverified. Ripgrep is required for search. Echo requires no
vendor account. [VERSIONS](docs/VERSIONS.md) lists actual capability checks.
`install-prereqs` offers attended Node/Claude Code/Codex installation after
Node is available to run the setup wrapper.

## Install

From an extracted release or checkout outside your vault:

```text
bin\council-setup.cmd detect --vault "C:\Users\<you>\Vault"
bin\council-setup.cmd plan --vault "C:\Users\<you>\Vault"
bin\council-setup.cmd apply --plan "<file printed by plan>"
bin\council-setup.cmd verify
bin\council-setup.cmd login
```

Review the plan and confirm apply in your terminal. Apply downloads nothing.
Fully quit and restart Claude Desktop after registration and add the supplied
project instructions. For Gemini, follow with `bin\council-setup.cmd set-key`:
hidden input is validated and stored under the profile's DPAPI-protected
runtime secrets directory. See [INSTALL](docs/INSTALL.md) for writes, exit
codes, login guidance and regional billing information via [NOTICE](NOTICE.md).

## Your vault

Council adopts your folder in place. It adds a path-free `.council/vault.json`
contract, missing rules files or marked rule blocks, and work directories.
Optional conventions add inbox/shared/output/index files. Jobs and ledger
default to the vault and can be relocated. It never moves existing notes,
reorders your index, deletes duplicates or installs executable code in the vault.
Existing files are backed up whole outside the vault before edits; conflicting
user edits are kept. See [VAULT-CONTRACT](docs/VAULT-CONTRACT.md).

## Where things live

| Zone | Example | Purpose |
|---|---|---|
| Z0 | `C:\Users\<you>\AppData\Local\council\app\0.1.0` and sibling `bin` | Installed runtime and stable launcher |
| Z1 | `C:\Users\<you>\AppData\Local\council\etc` | Machine/profile config, manifests, journal and backups |
| Z2 | `C:\Users\<you>\AppData\Local\council\run\default` | Scratch, secrets, and jobs/ledger when relocated |
| Z3 | `C:\Users\<you>\Vault` | Your notes, rules, tasks and default jobs/ledger |

Use `--profile <id>` consistently for several vaults. Profiles share the
installed application and shared skill; each owns its configuration and
runtime. Keep Z0/Z1 outside agent write grants. See [CONFIG](docs/CONFIG.md).

## The eight tools

| Tool | Purpose |
|---|---|
| `council_start` | Start one consultation or a fan-out |
| `council_poll` | Wait for progress or read results; default wait 40 seconds, maximum 45 |
| `council_ask` | Single-leg blocking convenience; degrades to a job ID when its host window ends |
| `council_cancel` | Cancel a job and its process tree |
| `council_list` | Find recent jobs across hosts |
| `council_search` | Ripgrep content search inside your vault |
| `council_doctor` | Zero-quota diagnostics and optional version probes |
| `council_ledger` | Inspect local usage, estimates and refusals |

Arguments, result shapes, paging and untrusted-output framing are in
[INTERFACES](docs/INTERFACES.md). Long consultations should use start/poll.

## The four legs

| Leg | Execution | Usage |
|---|---|---|
| Claude | Official Claude Code CLI in restricted scratch context | Your vendor account |
| Codex | Official CLI with ignored user rules/config and read-only sandbox | Your vendor account |
| Gemini API | Council-owned HTTPS child with your API key | Your API project |
| Antigravity (`agy`) | **DISABLED** | See [NOTICE](NOTICE.md) |

The additional `echo` backend is a local fake for zero-quota checks.
Council charges no fee; vendor usage may cost money or consume quota.
See [PRICING](docs/PRICING.md).

## Safety

The invariant is that nothing agent-writable changes what runs. Derived narrow
executable roots, an argv guard, environment allowlisting, restricted/read-only
CLI execution and app integrity checks enforce it within the documented write
boundary. Untrusted configuration enters doctor-only mode. Leaf output is
framed as untrusted, with a single final `NEXT:` line from the renderer.

Shared hourly/daily/concurrency/depth fuses, deadlines and identity-checked
cancellation bound jobs. STOP files exist in the vault, profile runtime and
globally at `%LOCALAPPDATA%\council\STOP`. Whole-file backups cover edited
files, including host configuration, while recovery preserves unrelated host
entries. Removal follows manifest ownership; runtime/backup purges require
their own attended per-item decisions. Transient cleanup and explicit key
deletion have narrow scopes. This does not protect Z0/Z1 from a process granted
unrestricted access to your OS account. See [SECURITY-MODEL](docs/SECURITY-MODEL.md).

Use installer `update` and `uninstall` for lifecycle changes and read their
plans/reports. [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) covers host restart,
shim, proxy and sign-in issues. `node tests/run.mjs` runs the local zero-quota
gate; [TESTING](docs/TESTING.md) explains fixture isolation and skips.

## Not in 0.1.0

The following are deferred:

- macOS/Linux process, secrets and file-attribute implementations (planned for v0.2).
- npm publication and GitHub Actions beyond lint.
- Gemini multi-turn resume and a GUI.
- Router or debate-protocol changes.
- Measured minimum versions for Codex and Antigravity; the latter remains disabled, see [NOTICE](NOTICE.md).
- Claude Code project-scope registration and MSIX Claude Desktop as a first-class write target.
- Signed releases and pinned-binary-hash mode.
- Automatic translation of the rules block.

## Documentation

- [ARCHITECTURE](docs/ARCHITECTURE.md) — process model, zones and launcher rationale.
- [INSTALL](docs/INSTALL.md) — attended installation, writes and recovery.
- [CONFIG](docs/CONFIG.md) — machine/profile configuration, tokens and layout.
- [VAULT-CONTRACT](docs/VAULT-CONTRACT.md) — adoption, markers and conditional conventions.
- [PLATFORMS](docs/PLATFORMS.md) — platform capabilities and credential existence probes.
- [TESTING](docs/TESTING.md) — isolated zero-quota tests and explicit skips.
- [RELEASING](docs/RELEASING.md) — tracked-tree staging, tags and release assets.
- [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) — diagnostic reasons and host fixes.
- [MIGRATION](docs/MIGRATION.md) — generic transition from an older in-vault install.
- [SECURITY-MODEL](docs/SECURITY-MODEL.md) — trust boundaries, controls and residual risks.
- [VERSIONS](docs/VERSIONS.md) — enforced floors, tested versions and capability probes.
- [PRICING](docs/PRICING.md) — vendor usage, fuses and ledger interpretation.
- [SPEC](docs/SPEC.md) — condensed normative contract for contributors.
- [INTERFACES](docs/INTERFACES.md) — eight MCP tools and all installer commands.
- [cancel-timing](docs/cancel-timing.md) — cancellation timing fields and interpretation.
- [INSTALLER-AUDIT-FIXES](docs/INSTALLER-AUDIT-FIXES.md) — installer audit decisions and fixes.
- [INSTALLER-READ-ONLY-DECISIONS](docs/INSTALLER-READ-ONLY-DECISIONS.md) — read-only installer decisions.
- [INSTALLER-VERBS](docs/INSTALLER-VERBS.md) — verification, update and uninstall details.
- [Release notes 0.1.0](docs/release-notes/0.1.0.md) — shipped scope and deferrals.

Also read [NOTICE](NOTICE.md), [SECURITY](SECURITY.md) and
[CONTRIBUTING](CONTRIBUTING.md).

## Acknowledgements

The independent-answer, cross-examination and chair structure draws on the
open-source llm-council project. Council uses the official vendor CLIs and
ripgrep; vendor software is installed separately and retains its own terms.

## License

[MIT](LICENSE). Not affiliated with Anthropic, OpenAI or Google.
