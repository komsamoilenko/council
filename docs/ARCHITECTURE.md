<!-- Owns architecture documentation; specification §§2–6,14. -->
# Architecture

The parts that are not obvious, and the decisions that look wrong until you know what
they are working around. Everything here is measured on a real machine unless it says
otherwise.

## The constraint that shapes everything

Claude Desktop abandons an MCP tool call after **60 seconds**. Measured with a probe
server that logs its own timeline: a `tools/call` at +1298.2 s, the client's
`notifications/cancelled` at +1358.2 s — exactly 60.0 s later. The same ceiling applies
on both the Chat and the Code tab. Two consequences:

- The Chat client sends **no** `progressToken`, so a server cannot emit progress
  notifications at all, let alone use them to extend the timer. Keep-alive by progress
  is not an option, and no amount of configuration changes this.
- The Chat client sends **no** cancellation either: it simply stops listening while the
  server keeps working. Finished work is discarded and the quota is spent anyway.

Claude Code's CLI has no such cap (a 300 s call completes). So one server must serve
both: everything long is a **job**, and the host polls it.

## Three tiers

```
host                    Claude Desktop · Claude Code · Codex app or VS Code extension
 └─ server.js           stdio MCP, one process per host, holds almost no state
     └─ runner.js       detached, one per job: owns the deadline, the heartbeat, the ledger row
         └─ leaf        claude.exe · node codex.js · the Gemini HTTPS child
```

The server is a front end. Every answer it gives is read from disk, which is why a job
started in the Codex app is pollable from Claude Desktop, and why a host restart loses
nothing. The runner is detached on purpose: it outlives the server that started it.

`council_poll` blocks for at most 45 seconds and returns on a *meaningful* change — a leg
starting, output arriving, a terminal state — never on the bare heartbeat. That keeps a
ten-minute job to four round trips instead of fifteen, and stays inside every host's
60-second window with room to spare.

## Trust zones

The vault is a folder the user's agents can write to through a filesystem MCP server.
That is the whole threat model in one sentence. So:

| Zone | Written by | Contains |
|---|---|---|
| Z0 code | the installer only | the app, versioned, outside the vault |
| Z1 machine config | the installer only | binary paths, profiles — outside the vault |
| Z2 runtime | the server and runner | jobs, ledger, secrets — outside the vault |
| Z3 vault | the user and their agents | notes, task folders, the rules file |

The invariant: **after installation, nothing an agent can write inside the vault changes
what council runs.** The list of binaries council will execute, and the flags it refuses
to pass, are hardcoded in `guard.js` — not in a config file, because a config file inside
the vault is agent-writable. A rewritten config can only *narrow* what runs; anything
outside the allowed roots drops the server into a doctor-only mode where it answers
health questions and spawns nothing.

Two files deliberately live outside the vault for the same reason: the kill file, and the
gate that would enable the Antigravity adapter. An injected agent must not be able to
create either.

## Why the registration does not name `server.js`

Hosts are registered against `node <root>/bin/council-server.js` — a small launcher stub
— rather than against the versioned `app/<version>/server.js` that actually runs.

This looks like pointless indirection. It is what makes an update a rename instead of an
edit to three host configuration files owned by three different applications, two of
which require an application restart to notice. The stub resolves the current version and
loads the real server **as the main module** (`Module.runMain`), because `server.js` only
starts when it is the main module; a launcher that merely `require()`s it would load the
code and start nothing.

The intent behind the original rule — node plus an absolute path, never the npm `.cmd`
shim — is preserved. That rule exists because the `.cmd` shim on Windows breaks MCP's
stdio framing: a server launched through it hangs on the first request. This was hit once
and diagnosed the hard way; it is not theoretical.

Do not "simplify" this back to naming `server.js` directly.

## Why every child gets a stripped environment

A consultation leaf runs with an allowlisted environment: about two dozen OS variables, a
fixed `PATH`, and nothing else. Every `ANTHROPIC_*`, `OPENAI_*`, `GOOGLE_*`, `GEMINI_*`,
`OTEL_*`, `MCP_*` and `CLAUDE_*` variable is dropped, as are `NODE_OPTIONS` and
`RIPGREP_CONFIG_PATH`.

Two reasons. The obvious one is that a leaf should not inherit credentials it does not
need. The measured one: a trivial `claude -p` from a project folder loaded about
**43,000 tokens** of context — a global rules file, hooks, dozens of skills — before
reading the question. The same call from a scratch directory with `--safe-mode
--restricted` costs about **800**. Fifty times cheaper, for an identical answer.

## Why the debate stops at two rounds

Not taste. Increasing the number of debate rounds measurably decreases accuracy
([arXiv:2502.19130](https://arxiv.org/abs/2502.19130), ACL 2025 Findings), and stances
homogenise across rounds while factual content decays — convergence happens
independently of correctness ([arXiv:2606.03032](https://arxiv.org/abs/2606.03032)).
Multi-agent debate also does not reliably beat plain independent sampling, at two to
three times the cost ([arXiv:2311.17371](https://arxiv.org/abs/2311.17371)).

So: independent answers first, a debate only when they diverge or the stakes are high,
two rounds, and four terminal states of which "converged but unverified" is one — named
that way so an agreement nobody checked cannot be mistaken for a result. An agent that
changes position must name the specific evidence that moved it; a flip without one is
discarded.

## Why the ledger is append-only JSONL

One `writeSync` of one line on a file opened for append is atomic enough for several
concurrent writers on the same machine, needs no lock, and survives a crash mid-write as
at most one unparseable line that readers skip and count. It is also greppable a year
later. Monthly rotation, never rewritten, never pruned by the server.

The only `unlink` anywhere in the server is the expiry of a stale lock file. No job,
ledger or user file is ever removed by the running system; deletion is a separate script
the user runs by hand.

## Known residual risks

- A leaf reads the disk under its own sandbox. A prompt-injected consultation can read
  files and put them in its answer, which then reaches the caller inside an untrusted
  marker. The markers are framing, not containment.
- Anyone who can rewrite `guard.js` itself owns the server. That is why the code lives
  outside the vault; it is not otherwise closed.
- `taskkill /T /F` is best-effort. A survivor is reported as an orphan rather than
  silently called dead.
