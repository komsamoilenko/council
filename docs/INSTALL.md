# Installation

## Prerequisites

Use Windows and Node.js 20.11 or newer. The installer enforces 20.11.0;
runtime and launcher checks have used Node 24.11.1. The launcher on the older
floor remains unverified, so use Node 24 for the tested path. See [VERSIONS](VERSIONS.md).
Extract the release or use a checkout outside your vault. Read [NOTICE](../NOTICE.md).
You need the official Claude Code or Codex CLI for those legs, and your own
Gemini API key for the Gemini leg. Echo needs no vendor account. Ripgrep is
required for vault search; detection also looks in the supported vendor package.

Once Node can run the installer, `bin\council-setup.cmd install-prereqs`
provides the attended prerequisite path. Select `--node`, `--claude`, or
`--codex`, or let it offer the missing items. It prints package-manager metadata
and commands before each confirmation. Winget verifies its manifest hash; npm
verifies registry integrity and installs the version shown. Council does not
re-verify those downloads. `--print-only` queries metadata but installs nothing.
This verb requires a terminal and accepts no `--yes`. Install Node yourself
first if no Node executable is available to run the wrapper.

## Detect and plan

Run these from the extracted project directory in a terminal. Substitute your
vault path and the plan filename printed by `plan`:

```text
bin\council-setup.cmd detect --vault "C:\Users\<you>\Vault"
bin\council-setup.cmd plan --vault "C:\Users\<you>\Vault"
bin\council-setup.cmd apply --plan "<file>"
bin\council-setup.cmd verify
bin\council-setup.cmd login
bin\council-setup.cmd set-key
```

Use the same `--profile <id>` on every command when installing a named profile.
Detection reports platform capabilities, Node, Git, npm, CLI versions, hosts,
login indicators, vault state, installation state, open journals and region
guidance. It writes nothing by default. `--out` explicitly writes a new report;
`--duplicates` explicitly writes a duplicate report under `etc\reports`.
Credential-store checks test existence only; Codex also has a login-status probe.

`plan` asks for unresolved choices, prints all WILL sections, and saves only its
declared plan under `%LOCALAPPDATA%\council\etc\plans\<timestamp>.json`
plus an explicitly requested duplicate report. Review the paths, changes,
backups, registrations and warnings. Existing vaults are adopted in place.
`--conventions` adds the optional inbox/shared/output/index conventions;
`--relocate-runtime` places jobs and ledger outside the vault. See [CONFIG](CONFIG.md)
and [VAULT-CONTRACT](VAULT-CONTRACT.md). Planning does not test vault writability
by writing a probe; apply does that first.

## Apply

Confirm the reviewed plan in the terminal. `apply` re-surveys its inputs and
refuses a stale plan. Nothing is downloaded by `apply`: application files and
templates come from the local source tree. It does not install CLIs or log in.

The journalled stages create the write probe, take the setup lock, back up
pre-existing files, install the versioned app and stable launcher, publish local
configuration, create runtime directories, merge vault rules, run Tier 0,
register hosts, record the manifest and shared skill, then commit the journal.
Registration occurs only after Tier 0 passes.

| Location | What apply writes |
|---|---|
| `%LOCALAPPDATA%\council\app\0.1.0` | Versioned runtime |
| `%LOCALAPPDATA%\council\bin` | Stable server launcher |
| `%LOCALAPPDATA%\council\etc` | Current-version pointer, machine configuration, profiles, manifests, journal and backups |
| `%LOCALAPPDATA%\council\run\<id>` | Scratch directories and empty child configuration; later, protected secrets |
| Your vault | Path-free contract, missing rules files or marked blocks, selected conventions, work and default jobs/ledger directories |
| Host configuration | Council's entry in Claude Code, Claude Desktop and shared Codex configuration, as selected |
| Claude configuration directory | Shared `skills\council-setup\SKILL.md`, tracked and reference-counted |

Whole-file pre-images live under `etc\backups\<profile>\<timestamp>`, outside
the vault. An ACL warning means their protection relies on the surrounding
profile permissions; the backup remains readable. Conflicting user edits are
kept and reported with proposals, rather than overwritten.

## Verify and restart hosts

`verify` checks installation integrity and drift, runs isolated zero-quota
checks and directly probes registrations over stdio. The default uses the fast
Tier-0 selection; `--full` requests the broader selection. `--fast` and `--hosts`
are accepted flags but do not change this build's verification flow. Direct probes
prove the server works; they do not prove the host has reloaded its configuration.
Fully quit and restart Claude Desktop, and add the supplied council project
instructions where required. Reopen the other hosts as needed and use
`council_doctor` to inspect their server. Verification uses temporary fixtures
and prefixed probe artifacts, cleaning its recorded temporary files afterwards.

## Login and Gemini key

`login` is an attended walkthrough. Run the vendor login commands yourself in
another terminal; council never automates sign-in or opens vendor credential
stores. The walkthrough writes no council configuration. Vendor login tools
manage their own files. `--only claude|codex|gemini` selects one walkthrough.
`CLAUDE_CONFIG_DIR` is not forwarded to consultation children; a relocated
Claude configuration can therefore appear signed out. See [TROUBLESHOOTING](TROUBLESHOOTING.md).

For Gemini, run `set-key` after installing the profile. It accepts hidden terminal
input or stdin, never a key argument. It validates the key with a models-list
HTTPS request and stores a DPAPI-protected blob at
`%LOCALAPPDATA%\council\run\<id>\secrets\gemini-api-key.dpapi` by default.
This is a network request, not an echo test; no claim of measured zero quota is
made for key validation. The result contains only storage status and the last
four characters. `set-key --delete` requires a terminal confirmation and removes
only that profile's key file. Regional billing guidance is in [NOTICE](../NOTICE.md).
The Antigravity adapter ships disabled; see [NOTICE](../NOTICE.md).

## Exit codes and recovery

| Code | Meaning | Next action |
|---|---|---|
| 0 | Success | Continue; read warnings and pending hosts |
| 1 | Step failed | Read the reported fix; inspect the journal before retrying |
| 2 | Usage or precondition | Correct the flag, prerequisite or path; regenerate the plan if inputs changed |
| 3 | Stale plan | Run detect and plan again; review the new plan |
| 4 | Conflict | Review the conflicting file or proposal; preserve user edits and resolve deliberately |
| 5 | Open journal or declined confirmation | If declined, stop; otherwise inspect detect and resume the same plan or roll back its journal |
| 6 | Unsupported platform | Use Windows for installation and supervised consultations |
| 7 | Verification drift | Inspect drift details, repair through the installer, then verify again |

Recovery uses `apply --plan "<file>" --resume` or
`rollback --journal <timestamp>`. Never clear a live setup lock;
`unlock --force-unlock` is for stale owners only. See [INTERFACES](INTERFACES.md)
for all flags, [MIGRATION](MIGRATION.md) for an older installation, and
[RELEASING](RELEASING.md) for release production.
