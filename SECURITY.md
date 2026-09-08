<!-- Owns security documentation; specification §§2–6,14. -->
# Security

## Reporting

Open a private security advisory from this repository’s Security tab. Please do not open a public issue for a vulnerability. This is a
personal project with no SLA; expect a reply in days, not hours.

## Threat model

council runs on one person's machine and starts AI CLIs as child processes. The
interesting adversary is not a network attacker — it is **text**: a web page a leaf
reads, a file in the vault, a consultation prompt written by another agent. Assume
prompt injection reaches every tool argument and every leaf's output.

What the design does about it:

- **The vault is untrusted input.** Agents can write there through a filesystem MCP
  server, so nothing inside it decides what council executes. Executable roots are derived from trusted machine locations, and the minimum forbidden
  flags are fixed in source outside the vault. A
  tampered config can only narrow what runs; anything unexpected drops the server into a
  doctor-only mode that spawns nothing.
- **A vault STOP can only reduce capability.** Additional STOP files and protected
  runtime state live outside the vault.
- **Fuses before every spawn**: recursion depth (a leaf may not start another
  consultation), calls per hour and per day, concurrent jobs, per-job wall clock, a kill
  file. A tripped fuse writes a ledger row and spawns nothing.
- **Stripped child environment.** An allowlist of about two dozen OS variables and a
  fixed `PATH`. No vendor credential variable is ever forwarded.
- **Supported providers receive prompts over stdin.** The disabled legacy adapter
  retains its guarded argument-based protocol. Argv is checked against a hardcoded forbidden-flag list
  before every spawn.
- **Leaf output is marked untrusted** where it is rendered, and the only instruction a
  calling model should follow is the server's own final line.
- **Deletion is not a runtime capability.** The server removes only expired lock files.
  Jobs, the ledger and user files are never deleted by the running system.

## What is not solved

- A leaf can read the disk under its own sandbox and put what it finds into its answer.
  The untrusted markers are framing, not containment.
- Anyone who can rewrite council's own source owns the server. Keeping the code outside
  the vault raises the bar; it does not close the hole.
- Process-tree kill on Windows is best-effort. A survivor is reported as an orphan.

## Credentials

council has no login of its own and never reads, stores or forwards a vendor OAuth token
or session cookie. The one credential it can hold is a Gemini API key you give it
explicitly, stored DPAPI-protected outside the vault and passed to its own HTTPS child
over stdin. It never appears in your notes, in argv, in a host configuration council
writes, in the ledger or in a log. See [NOTICE.md](NOTICE.md).

## Storage zones and detection limits

| Zone | Location and owner |
|---|---|
| Z0 code | Versioned app directory outside the vault; installed once and integrity checked |
| Z1 configuration | Local application-data etc directory; human and installer controlled |
| Z2 runtime | Profile runtime directory; installer-created, server/runner-written, encrypted key stored separately |
| Z3 vault | Notes and task contracts; writable by users and agents, treated as hostile |

A shell-capable agent running as the same user can rewrite Z0, Z1 or Z2. Integrity
checks, doctor and ledger provide detection against that adversary; prevention applies
to an agent confined to the vault and to restricted leaf capabilities. A vault-local
.mcp.json could also register a different server under the council name; registration
inspection belongs to the installer verification task.

DPAPI protects a stored API key at rest against other users and machines. It does not
protect against another process running as the same user. Runtime purge during uninstall
requires its own confirmation and deletes the encrypted key. The installer is a later
implementation task; this port does not implement that deletion flow.
