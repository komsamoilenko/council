<!-- Owns notice documentation; specification §§2–6,14. -->
# NOTICE

`council` is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or Google.

Vendor terms checked: 2026-09-10, against the pages as they stood that day (Anthropic's Claude Code legal page last modified 2026-08-21, Consumer Terms effective 2025-10-08, Usage Policy effective 2025-09-15; OpenAI Terms of Use effective 2026-01-01, Usage Policies effective 2025-10-29, Service Terms updated 2026-06-12; Gemini API Additional Terms effective 2026-03-23, page updated 2026-04-28; Google APIs Terms last modified 2021-11-09; the Antigravity terms and FAQ carry no date). They change; re-read the linked pages before relying on this file.

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

- Anthropic — [Claude Code: Legal and compliance](https://code.claude.com/docs/en/legal%2Dand-compliance), [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), [Usage Policy](https://www.anthropic.com/legal/aup)
- OpenAI — [Terms of Use](https://openai.com/policies/row-terms-of-use/) (users in the EEA, Switzerland and the UK: [EU Terms of Use](https://openai.com/policies/eu-terms-of-use/)), [Usage Policies](https://openai.com/policies/usage-policies/), [Service Terms](https://openai.com/policies/service-terms/); the API is governed by OpenAI's Business Terms, linked from the Terms of Use
- Google — [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms), [Google APIs Terms of Service](https://developers.google.com/terms), [Generative AI Prohibited Use Policy](https://policies.google.com/terms/generative-ai/use-policy), [Antigravity Additional Terms](https://antigravity.google/terms/) and the [Antigravity FAQ](https://antigravity.google/docs/faq)

Four points bear directly on how council works.

**1. Keep your use ordinary and individual.** Anthropic writes: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." council makes it easy to start several agents at once. Do not run it as a shared backend for other people, do not run it unattended in a loop to consume a plan's quota, and do not use it to serve requests on anyone else's behalf.

**2. One account per vendor, and it is yours.** Anthropic: "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential…". OpenAI: "You may not share your account credentials or make your account available to anyone else…". council's `accounts.json` holds a label per backend so the ledger can record whose quota a run spent; it is not an account switcher, and must not be used to rotate accounts around a rate limit. OpenAI's terms say: "Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations we put on our Services." Google's API Terms say the same of their limits: "You agree to, and will not attempt to circumvent, such limitations documented with each API."

**3. No credentials in a repository.** Google's API Terms are explicit: "Developer credentials may not be embedded in open source projects." council reads your Gemini key from an environment variable in your own session or from a DPAPI-protected file under your local application data, never from a file inside your notes folder; council never writes one into a host configuration file, and never commits one. (If you choose to put `COUNCIL_GEMINI_API_KEY` into a host's own `env:` block yourself, that is your file and your decision — council cannot tell where an environment variable came from, and its installer refuses to write a key-shaped variable into one for you.)

**4. Where the written positions stop — and what they say about automation.** Anthropic's page says that "preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service" and lists conditions council satisfies: the binary is unmodified, each user signs in through Anthropic's own flow, and nobody's usage is paid for, resold or intermediated. Its section on authentication says that "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications", that developers "building products or services that interact with Claude's capabilities … should use API key authentication", and that this restriction does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". Anthropic's Consumer Terms separately forbid accessing the services "through automated or non-human means, whether through a bot, script, or otherwise" except "via an Anthropic API Key or where we otherwise explicitly permit it". Read together: with an API key you are inside what Anthropic has written; with a subscription, the written permission is the sentence about signing in to the unmodified binary, and whether a free, locally installed open-source tool that drives that binary is a "product or service" is not something Anthropic has written down. Its page says who can answer: "For questions about permitted authentication methods for your use case, please contact sales." It also says: "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice." OpenAI has published no page about third-party tools driving its CLI. Its Terms of Use forbid "Automatically or programmatically extract data or Output"; council starts your Codex CLI in its documented `codex exec` mode and reads what it prints, and OpenAI has not written down whether that counts. The API path is governed by OpenAI's Business Terms and Service Terms rather than the consumer Terms of Use; the Service Terms add that "Output generated by code generation features of our Services, including OpenAI Codex, may be subject to third party licenses". If you need certainty, ask the vendor; the API-key paths are the ones each vendor has written down.

## Antigravity (`agy`) — disabled, and why

council contains an adapter for Google's Antigravity CLI (`agy`). **It is disabled by default and you should leave it disabled.** Section 6 of Google's Antigravity Additional Terms of Service says:

> You must not abuse, harm, interfere with, or disrupt the Service. This includes, but is not limited to, using the Service in connection with products not provided by us. Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts.

The [Antigravity FAQ](https://antigravity.google/docs/faq) repeats it, names other coding agents, and gives the supported alternative:

> Using third party software, tools, or services to access Antigravity is a violation of our Terms of Service, and severely degrades the experience for legitimate product users. Such actions may be grounds for suspension or termination of your account. If you would like to use a third party coding agent with Gemini, we recommend using a Vertex or AI Studio API key.

council follows Google's own recommendation: **the supported Gemini path is an AI Studio or Vertex API key**, and it is the default. The installer will not install `agy`, will not enable the adapter, and no council documentation explains how to make it work — no `docs/` page, no template, no installer output and no skill describes the configuration it would take. The adapter refuses to run unless a file under council's runtime directory, which you must create yourself, begins with this exact sentence:

> I have read NOTICE.md and I accept that using agy with council may breach Antigravity Additional Terms of Service section 6.

This file is the only place that sentence appears outside the adapter's own source. Typing it is a decision you take against Google's stated terms; the terms name the consequence — "suspension or termination of your Antigravity and/or Gemini CLI accounts".

If you are in the European Economic Area, Switzerland or the United Kingdom, note Google's Gemini API Additional Terms: "You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom." For a single-user local tool the practical rule is the same: use a key on a project with billing enabled.

What Google does with what you send. On the unpaid tier, the Gemini API Additional Terms say that Google "uses the content you submit to the Services and any generated responses to provide, improve, and develop Google products and services and machine learning technologies", that "human reviewers may read, annotate, and process your API input and output", and: "Do not submit sensitive, confidential, or personal information to the Unpaid Services." council sends your prompt — which may include your code and notes — to that API. If that matters to you, use a key on a project with billing enabled; the same terms apply the paid-tier data handling to everyone in the EEA, Switzerland and the UK regardless of tier. The same terms say of agentic use: "You will not automatically bypass any requests for human confirmation" — council never answers a confirmation on your behalf. A Vertex AI key is governed by Google Cloud's terms, which the Gemini API Additional Terms say they do not cover.

## Names and logos

"Anthropic", "Claude" and "Claude Code" are trademarks of Anthropic, PBC. "OpenAI", "ChatGPT" and "Codex" are trademarks of OpenAI. "Google", "Gemini" and "Antigravity" are trademarks of Google LLC. council uses these names only to state factually which tool an adapter starts, as Anthropic's terms permit: "You can accurately say, in plain text, that your product has Claude Code preinstalled or that it runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name, in your own logo, or in a way that suggests Anthropic built, endorses, or is partnered with your product." council claims no endorsement by any of them and carries no vendor logo.

## Installing the CLIs

council's installer never bundles, mirrors or re-hosts vendor software. When you ask it to install a CLI it runs the vendor's own published package or installer (for example `npm install -g @anthropic-ai/claude-code`, `npm install -g @openai/codex`) and prints the exact command before running it. Everything it fetches comes from the vendor's official source, under that vendor's own license.

## What council will never add

No multi-account rotation for one vendor. No hosted or shared mode. No credential proxy or login of its own. No storing or forwarding of a vendor OAuth token or session cookie. Anthropic's terms assume "ordinary, individual usage"; OpenAI's forbid circumventing "any rate limits or restrictions". Pull requests implementing any of these are closed.

## License

council is MIT licensed; see LICENSE. The vendor CLIs it starts are not part of this project and keep their own licenses and terms.
