# NOTICE

`council` is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or Google.

Vendor terms checked: 2026-09-07. They change; re-read the linked pages before relying on this file.

## What council does, and what it does not do

council is a local MCP server. When you run a consultation or a debate, it starts the AI coding CLIs **that you installed on your own machine**, as child processes, and reads what they print.

| Leg | What council starts | Whose account pays |
|---|---|---|
| `claude` | the official, unmodified Claude Code binary in its documented non-interactive mode (`claude -p --output-format json …`) | your own Claude subscription or API key |
| `codex` | the official, unmodified Codex CLI in its documented non-interactive mode (`codex exec …`) | your own ChatGPT plan or OpenAI API key |
| `gemini` (default) | the Gemini API over HTTPS, with an API key you supply | your own AI Studio / Vertex key |
| `gemini` via `agy` | the Antigravity CLI — **disabled by default, see below** | your own Google account — *not permitted by Google's terms* |

council:

- ships **no** vendor binaries and **no** vendor code, and never modifies, patches, repackages or re-hosts one. It never removes, disables or restricts any sign-in method built into a vendor CLI.
- offers **no login of its own** and never reads, stores or forwards a vendor OAuth token or session cookie. The one credential council holds is the Gemini API key you give it with `council-setup set-key`, stored DPAPI-protected under your local application data (Windows) or read from `COUNCIL_GEMINI_API_KEY` in the server's own environment; it is passed to council's own HTTPS child over stdin and never appears in your vault, argv, a host configuration written by council, the ledger or a log. It never asks you for a vendor password. Each CLI reads its own credential store exactly as it does when you run it by hand — `~/.codex` for Codex, Claude Code's own credential store (on Windows `~/.claude/.credentials.json`) for Claude Code — and council never opens either of them; it tests only that the path exists, so it can tell you which sign-in step is still ahead of you. One caveat, stated plainly: council does not forward `CLAUDE_CONFIG_DIR` into the child process, so if you have relocated your Claude Code configuration with that variable, the child will read the default location and may behave as if it is not signed in (see `docs/TROUBLESHOOTING.md`). The one thing council does read under `~/.codex` is the local session rollout files, to show your Codex rate-limit snapshot in the ledger; those files are not credentials.
- builds a fixed allowlisted environment for every child process, so none of your `ANTHROPIC_*`, `OPENAI_*`, `GOOGLE_*`, `GEMINI_*` or `CLAUDE_*` variables are forwarded into it.
- pays for nothing and resells nothing. Every request is billed to you, under your own agreement with the vendor.
- is not a hosted service and has no server side. It runs on your machine, started by you, for you.

## Your vendor terms apply in full

Installing council changes nothing about your relationship with any AI vendor. **You are responsible for complying with the terms of every service you point council at**, including its quota, acceptable-use and automation rules:

- Anthropic — [Claude Code: Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), [Usage Policy](https://www.anthropic.com/legal/aup)
- OpenAI — [Terms of Use](https://openai.com/policies/row-terms-of-use/), [Usage Policies](https://openai.com/policies/usage-policies/)
- Google — [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms), [Google APIs Terms of Service](https://developers.google.com/terms), [Antigravity Additional Terms](https://antigravity.google/terms/)

Four points bear directly on how council works.

**1. Keep your use ordinary and individual.** Anthropic writes: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." council makes it easy to start several agents at once. Do not run it as a shared backend for other people, do not run it unattended in a loop to consume a plan's quota, and do not use it to serve requests on anyone else's behalf.

**2. One account per vendor, and it is yours.** Anthropic: "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential…". OpenAI: "You may not share your account credentials or make your account available to anyone else…". council's `accounts.json` holds a label per backend so the ledger can record whose quota a run spent; it is not an account switcher, and must not be used to rotate accounts around a rate limit. OpenAI's terms forbid "circumvent[ing] any rate limits or restrictions".

**3. No credentials in a repository.** Google's API Terms are explicit: "Developer credentials may not be embedded in open source projects." council reads your Gemini key from an environment variable in your own session or from a DPAPI-protected file under your local application data, never from a file inside your notes folder; council never writes one into a host configuration file, and never commits one. (If you choose to put `COUNCIL_GEMINI_API_KEY` into a host's own `env:` block yourself, that is your file and your decision — council cannot tell where an environment variable came from, and its installer refuses to write a key-shaped variable into one for you.)

**4. Where the written positions stop.** Anthropic's page also says that "preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service" and lists conditions council satisfies: the binary is unmodified, each user signs in through Anthropic's own flow, and nobody's usage is paid for, resold or intermediated. The same page states that nothing there prevents "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". Whether a free, locally installed open-source tool counts as a "product or service" under that sentence is not something Anthropic has written down; only Anthropic can answer it. OpenAI has published no equivalent page; its own documentation describes `codex exec` as the supported non-interactive mode, which is what council uses. If you need certainty for a commercial setting, ask the vendor.

## Antigravity (`agy`) — disabled, and why

council contains an adapter for Google's Antigravity CLI (`agy`). **It is disabled by default and you should leave it disabled.** Section 6 of Google's Antigravity Additional Terms of Service says:

> You must not abuse, harm, interfere with, or disrupt the Service. This includes, but is not limited to, using the Service in connection with products not provided by us. Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts.

The Antigravity FAQ repeats it, names other coding agents, and gives the supported alternative:

> Using third party software, tools, or services to access Antigravity is a violation of our Terms of Service, and severely degrades the experience for legitimate product users. Such actions may be grounds for suspension or termination of your account. If you would like to use a third party coding agent with Gemini, we recommend using a Vertex or AI Studio API key.

council follows Google's own recommendation: **the supported Gemini path is an AI Studio or Vertex API key**, and it is the default. The installer will not install `agy`, will not enable the adapter, and no council documentation explains how to make it work — no `docs/` page, no template, no installer output and no skill describes the configuration it would take. The adapter refuses to run unless a file under council's runtime directory, which you must create yourself, begins with this exact sentence:

> I have read NOTICE.md and I accept that using agy with council may breach Antigravity Additional Terms of Service section 6.

This file is the only place that sentence appears outside the adapter's own source. Typing it is a decision you take against Google's stated terms, and it can cost you your Google account.

If you use the Gemini API from the European Economic Area, Switzerland or the United Kingdom, note Google's Gemini API Additional Terms: "You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom." Use a key on a project with billing enabled.

## Names and logos

"Anthropic", "Claude" and "Claude Code" are trademarks of Anthropic, PBC. "OpenAI", "ChatGPT" and "Codex" are trademarks of OpenAI. "Google", "Gemini" and "Antigravity" are trademarks of Google LLC. council uses these names only to state factually which tool an adapter starts, as Anthropic's terms permit: "You can accurately say, in plain text, that your product has Claude Code preinstalled or that it runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name, in your own logo, or in a way that suggests Anthropic built, endorses, or is partnered with your product." council claims no endorsement by any of them and carries no vendor logo.

## Installing the CLIs

council's installer never bundles, mirrors or re-hosts vendor software. When you ask it to install a CLI it runs the vendor's own published package or installer (for example `npm install -g @anthropic-ai/claude-code`, `npm install -g @openai/codex`) and prints the exact command before running it. Everything it fetches comes from the vendor's official source, under that vendor's own license.

## What council will never add

No multi-account rotation for one vendor. No hosted or shared mode. No credential proxy or login of its own. No storing or forwarding of a vendor OAuth token or session cookie. Anthropic's terms assume "ordinary, individual usage"; OpenAI's forbid circumventing "any rate limits or restrictions". Pull requests implementing any of these are closed.

## License

council is MIT licensed; see LICENSE. The vendor CLIs it starts are not part of this project and keep their own licenses and terms.
