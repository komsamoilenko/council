<!-- Owns readme documentation; specification §§2–6,14. -->
# council

One MCP server that lets the AI assistant you are already talking to consult a **different vendor's** assistant, under your own subscriptions, and record what it cost.

You ask Claude a question. Claude asks Codex the same question independently, notices where the two answers disagree, argues that specific point with it, and tells you what is settled, what is merely agreed, and what is still open. All of it from inside Claude Desktop, Claude Code, or the Codex app — whichever you happen to be using.

> **Status: design complete, implementation in progress.** A working v1 runs on the author's machine (27 zero-quota tests green; one real consultation verified on each of three legs). This repository is being built from that v1 into something installable by other people. There is no release yet. See [Status](#status) below.

---

## Why this exists

Every assistant is confident. Two assistants from different vendors are confident *in different places*, and that is the useful signal. The problem is plumbing:

- Claude Desktop can call a tool, but abandons it after **60 seconds** — measured, on both its Chat and Code tabs. A real consultation takes minutes.
- The vendors' subscriptions are reachable only through their own CLIs. Automating their web interfaces breaks their terms and their anti-bot defences, and every project that tried has rotted.
- Nothing tracks which of your accounts paid for what.

council is the missing middle: an MCP server that starts the official CLIs as child processes, runs the long work as background jobs the host can poll, and keeps a ledger.

## What it does

- **Consult across vendors.** `council_start` fans a prompt to one, two or three legs; `council_poll` returns progress every 40 seconds, inside every host's timeout. A ten-minute consultation survives a host restart, because job state lives on disk.
- **Debate, with a protocol that does not reward capitulation.** Independent answers first; a debate opens only when they diverge or the stakes are high. Two rounds, not five — more rounds measurably *decrease* accuracy ([arXiv:2502.19130](https://arxiv.org/abs/2502.19130)), and convergence happens independently of correctness ([arXiv:2606.03032](https://arxiv.org/abs/2606.03032)). A verdict is one of four named states, and "we agreed but checked nothing" is one of them, spelled out as such.
- **Route by task class.** A short factual question does not need three frontier models at maximum reasoning effort. The router picks the legs, the models and the effort per class, deterministically, with no model call of its own.
- **Account for it.** An append-only ledger records tokens, wall time, estimated cost and *which account paid*, per leg. `council_ledger` renders it.
- **Refuse to run away.** Recursion depth, calls per hour and per day, concurrent jobs, per-job wall clock, a kill file, and a cancel that kills the whole process tree. An abandoned call stops burning quota instead of finishing into the void.
- **Search your notes.** `council_search` is ripgrep over your vault; the reference filesystem MCP server has no content search at all.

## What it is not

Not a chat UI, not a hosted service, not an account switcher, not a way to use one subscription for several people. It ships no vendor code and holds no vendor login. See [NOTICE.md](NOTICE.md) — read it before you install anything.

## How it works

```
your host (Claude Desktop · Claude Code · Codex app or extension)
  └─ stdio MCP server            one per host, stateless front end
       └─ detached job runner    owns the deadline, heartbeat and the ledger row
            └─ one leaf per leg  claude · codex · gemini
```

The host never waits more than 45 seconds for anything. Everything a tool answers with is read from disk, so a job started in one host is pollable from another.

## The legs

| Leg | How it runs | Whose quota |
|---|---|---|
| `claude` | the official Claude Code binary, `claude -p --output-format json`, in a scratch directory with `--safe-mode --restricted` | your Claude subscription or API key |
| `codex` | the official Codex CLI, `codex exec --json --ignore-user-config` | your ChatGPT plan or OpenAI API key |
| `gemini` | the Gemini API over HTTPS with your AI Studio or Vertex key — the path Google itself recommends for third-party agents | your Google API key |
| `echo` | a local fake used by the whole test suite | nothing |

An adapter for Google's Antigravity CLI exists in the source and **is disabled**, because Google's terms forbid third-party software from using it. It is not documented anywhere but [NOTICE.md](NOTICE.md), which explains why you should leave it alone.

## Status

| | |
|---|---|
| Design | complete — repository, installer, migration and test plan specified and adversarially reviewed |
| Runtime (v1) | working privately: 27 zero-quota tests green, one real call verified per leg, running in three hosts on one machine |
| This repository | runtime, read-only planning, apply, host registration and rollback implemented; verify, update and uninstall remain pending |
| Platforms | Windows implemented; macOS and Linux are designed for and stubbed, not written |
| Release | none yet. No tags, no npm package, nothing to install |

Watch [CHANGELOG.md](CHANGELOG.md). When there is something to install, it will say so there first.

## Planned installation

Nothing here works yet; this is the shape it will take.

```
council-setup detect     # report what is installed, signed in and registered. Writes nothing.
  council-setup plan       # declare writes and save a plan outside the vault
  council-setup apply --plan <saved-plan> --yes  # journalled and reversible
council-setup verify     # run the zero-quota suite and council_doctor in every host
council-setup uninstall  # unregister, and remove only what the manifest says we created
```

The installer **adopts an existing folder in place**: it never moves, renames or deletes your files. A file it must extend gets a marked block and a dated backup; duplicates are reported, never removed. The code lives outside your notes folder, so nothing an agent can write inside the vault changes what council runs.

## Documentation

- [NOTICE.md](NOTICE.md) — vendor terms, what council holds and what it never touches. Read first.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the process model, trust zones and the decisions that look odd until explained.
- [SECURITY.md](SECURITY.md) — threat model and how to report a problem.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how the repository is organised and what a change must not break.

## Acknowledgements

The three-stage council shape — independent answers, cross-examination, a chairman — follows Andrej Karpathy's [llm-council](https://github.com/karpathy/llm-council). The protocol's stopping rules come from the multi-agent-debate literature rather than from intuition; the papers are cited where the rules are stated.

## License

[MIT](LICENSE). Not affiliated with Anthropic, OpenAI or Google.
