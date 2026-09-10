# Security model

## Trust zones and invariant

**Nothing agent-writable changes what runs.** This assumes the agent's write
access is confined to the vault and any deliberately exposed data directories.
Council runs as your OS user; it is not a separate OS account protecting you
from another process with unrestricted access to that user's files.

| Zone | Owner and contents | Default Windows location |
|---|---|---|
| Z0 | Installer-managed application and launcher | `%LOCALAPPDATA%\council\app` and `bin` |
| Z1 | Installer-managed machine/profile configuration, manifests and backups | `%LOCALAPPDATA%\council\etc` |
| Z2 | Runtime scratch and secrets; jobs/ledger when relocated | `%LOCALAPPDATA%\council\run\<id>` |
| Z3 | Your notes, rules and task files; default jobs/ledger | Your vault |

Keep Z0 and Z1 outside all vaults and agent write grants. Runtime paths must
stay within the configured vault or runtime root and outside executable code.
The path-free vault contract is discovery data, never runtime authority.
Machine binary settings replace profile binary values; allowed executable
roots are derived narrowly from platform and vendor locations. Configuration
cannot turn the vault or an entire package root into an executable allowlist.

## Boot checks and argv guard

Boot verifies installed profile trust, lexical and resolved paths, and the app's
integrity manifest. Failure enters doctor-only mode. Diagnostics and permitted
reads remain available when their paths can be resolved; execution is refused.
Unsupported platform capabilities similarly refuse supervised execution.

The runner rechecks mutable job data before each spawn: executable identity,
allowed roots, argument shape, forbidden flags, working directory, profile and
read grants. Prompts travel over stdin, not a shell command. Child processes
use executable paths and argument arrays with no command shell. Hosts register
absolute Node plus the stable JavaScript launcher, never a command shim.
An edited `spawn.json` is a request to validate, not executable authority.

Claude runs in scratch with safe/restricted mode, empty MCP configuration,
explicit tools and noninteractive permissions. Codex ignores user configuration
and rules and pins a read-only sandbox, including resumed calls. Requested
read paths must resolve inside the vault and outside excluded jobs, ledger and
code paths; files are staged as copies so granting their parent cannot grant
the entire vault. Read access can still expose the selected content to a vendor.

## Child environment and proxy scope

Children receive the Windows OS-variable allowlist, a fixed system/Node PATH,
and council-owned job/depth settings. Arbitrary inherited variables are dropped,
including vendor key prefixes, MCP settings, `NODE_OPTIONS` and
`RIPGREP_CONFIG_PATH`. Extra environment fields in a job cannot restore those
variables or override PATH. Claude's updater is disabled; Codex gets its
default per-user configuration home for vendor-managed authentication.
`CLAUDE_CONFIG_DIR` is not forwarded, which can affect relocated sign-ins.

`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS` can reach only
the Gemini API child. Values originate in the server/runner environment and
are validated again, not trusted from the mutable job document. The current
validator applies an HTTP(S) URL check to all three proxy variables, including
`NO_PROXY`; conventional comma-separated bypass lists therefore get ignored.
The CA file must be absolute, readable, and outside every known vault/runtime
root. Rejections appear as `proxy_env_ignored:<name>` diagnostics.

## Secrets and redaction

Vendor CLIs own their sign-in stores. Council checks existence or vendor login
status without opening those stores. Gemini's supported API route accepts a
server-side key or the profile's Windows DPAPI store; the key goes to the
council-owned HTTPS child in a stdin header, never argv, a host registration,
job JSON or the ledger. `set-key` uses hidden input or stdin and validates before
storage. See [INSTALL](INSTALL.md) and [NOTICE](../NOTICE.md).
The Antigravity adapter ships disabled; see [NOTICE](../NOTICE.md).

Redaction filters runtime output, structured tool payloads, ledger data and
installer error reports. It is defense in depth, not permission to put secrets
in prompts. Prompts, answers and logs are local artifacts and may contain
sensitive user content. Backups can contain unrelated host secrets because
they are whole-file pre-images. They remain outside the vault with owner ACL
restriction attempted and readability checked; failure is reported as
`backup_acl_not_restricted` rather than silently claiming protection.

## Fuses, cancellation and reaper

Starts check STOP files, depth, vault availability and prompt limits before
spawning. Shared reservations count legs, not tool calls: rolling hourly,
daily and concurrency caps apply across hosts of a profile, with a fan-out
reserved entirely or refused entirely. Defaults are 20 legs/hour, 80/day,
3 concurrent and maximum depth 2. See [PRICING](PRICING.md).

STOP locations include the vault's `STOP`, the profile runtime's `STOP`, the
global `%LOCALAPPDATA%\council\STOP`, and configured extra stop paths.
The global file remains outside vault-only agent access. The runner enforces
deadlines, observes cancellation and bounds captured output. Budget controls
are backend-specific; fuses do not guarantee a universal dollar ceiling.

The detached runner survives host disconnection and owns heartbeat, deadline
and ledger finalization. Cancellation verifies process identity before killing
the tree. The reaper combines stale disk state with process identity evidence;
a stale heartbeat alone is not proof of death. Unevaluable identity stays
unverified, and a suspected survivor is reported as an orphan/error, not a
successful cancellation. Process-tree termination is best effort.

## Compromised vault agent

An injected agent can change notes and rules, corrupt or forge data it can
write, create a vault STOP file, and submit allowed consultations within the
fuses. If jobs or ledger are exposed to it, their contents are not tamper-proof
evidence. It can place malicious text in an answer or search hit. The renderer
indents leaf text inside untrusted-output markers and provides one final
`NEXT:` line; consumers must still treat that text as evidence, not instructions.

An agent can also write project-level host configuration in the vault; that
may register a different server under a familiar name. Trust in the installed
council binary does not authenticate every server a host might select.

Within the assumed write boundary it cannot replace the installed guard,
authorize a new executable root, inject shell arguments, forward arbitrary
environment secrets, or change the trusted profile by editing the vault
pointer. It cannot remove an external STOP file through vault-only access.
Giving it unrestricted shell access or write access to Z0/Z1 invalidates that
boundary. Integrity hashes detect drift; they are not signed provenance.
