# Interfaces

## Transport and result envelope

The server exposes eight MCP tools over stdio JSON-RPC. Tool schemas reject
unknown properties; invalid arguments use JSON-RPC `-32602`. Operational
refusals use tool results. Every rendered tool result has this shape:

```text
{ content: [{type: "text", text: <screen>}],
  structuredContent: <payload>, isError: <boolean> }
```

The screen contains a status, body and JSON rendering of the payload, followed
by exactly one unindented `NEXT:` line as its last line. Answers appear in
screen text, not as a plain answer string in `structuredContent`:

```text
<<<COUNCIL_UNTRUSTED_OUTPUT job=<id> leg=<leg>>>>
  every line of third-party output is indented two spaces
<<<END_COUNCIL_UNTRUSTED_OUTPUT>>>
```

These markers frame evidence, not instructions. Terminal leg records have
`untrusted:true` and `untrusted_fields` identifies third-party fields.
Consumers must not treat model strings or embedded instructions as authority.
Refusals commonly contain `job_id`, `state:"refused"`, `refuse_reason`,
`detail`, and sometimes `resets_in_s`, `running` or `backend`. Unsupported
platform refusals also carry `refused:true` and `reason`. Missing jobs return
`state:"not_found"`. Inspect the payload instead of assuming one success shape.

## council_start

Required: `prompt`, a string of 1-200000 characters. Runtime byte/control
checks also apply. Optional arguments:

| Argument | Type and limits |
|---|---|
| `backends` | 1-3 entries from `claude`, `codex`, `gemini`, `echo`; omitted means router choice |
| `task_class` | `quick`, `writing`, `code_review`, `architecture`, `research`, `verify`, `judge`, `general` |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max`; clamped by backend |
| `model` | Map to model strings matching `^[a-z0-9][a-z0-9._-]{0,63}$` |
| `context_note` | String, maximum 4000 characters |
| `stakes` | `normal` (default) or `high` |
| `timeout_s` | Integer 30-1800; can only lower the selected class timeout |
| `max_cost_usd` | Number 0.01-5; can only lower the selected class budget; Claude leg only |
| `continue_from` | Existing job ID |
| `force_round` | Boolean, default false |
| `reason` | String, maximum 300 characters |
| `read_paths` | Up to 5 vault paths, each at most 260 characters |
| `idempotency_key` | String, maximum 200 characters |
| `label` | String, maximum 80 characters |

Job IDs match `^j_[0-9]{13}_[0-9a-f]{6}$`. Routing and safety checks can refuse
schema-valid arguments. Duplicate echo legs are legal; real same-vendor pairs
are subject to routing refusal. `stakes:"high"` forces a cross-vendor pair
for start, adding a backend if needed (or reducing a full same-vendor list
to a pair); echo-only lists stay unchanged. `task_class:"judge"` ignores
`backends`, selects two Claude legs and bypasses the same-vendor check.
Read paths are validated; files over 50 MiB refuse with `vault_unavailable`.
The server stages files under the job directory, but the runner refuses those
staged `--add-dir` grants because jobs are excluded. Use a permitted narrow
vault directory for grant-bearing adapters. The Antigravity adapter is
disabled by default; see [NOTICE](../NOTICE.md).

The class ceilings are quick: 180 s/$0.20; writing: 600 s/$0.60;
code_review and architecture: 900 s/$1.50; research: 1200 s/$1.50;
verify: 600 s/$0.80; judge: 600 s/$1.00; general: 900 s/$1.00.
Configured fuse ceilings can lower them further. A larger caller value does
not raise a class ceiling.

A successful start returns `profile`, `vault`, `job_id`, `kind`, `state`,
`round`, `legs`, `router`, `deadline_at`, `poll_after_s:0`,
`reused_idempotent` and `fuses`. Each planned leg includes `backend`, `leg_id`,
`model`, `effort`, `effort_clamped_from`, `account`, `resumable`, `resumed`,
`session_id`, `judge_order` and `prompt_swapped`. A reused job reports its
current disk state. Follow with `council_poll`.

## council_poll

Required `job_id`. Optional `wait_s` is 0-45 (default 40); `offset` is an
integer at least 0 (default 0); `max_chars` is 500-200000 (default 60000);
`include_text` is boolean (default true). Zero wait reads immediately.
The same offset and character limit apply per leg. Meaningful state/output
changes wake the wait; a heartbeat alone does not.

Running payloads contain `job_id`, `state`, `lost_verified`, `kind`, `round`,
`task_class`, `label`, `elapsed_s`, `remaining_s`, `heartbeat_age_s`,
`deadline_at`, `poll:{n,of,wait_s}`, `legs` and `artifacts:{dir}`.
Progress legs include state, byte counts, events, elapsed time, cap flag,
last label and PID. `lost?` denotes an unconfirmed loss.

Terminal payloads contain `job_id`, `state`, `outcome`, `kind`, `round`,
`task_class`, `router`, `label`, `elapsed_s`, `wall_ms`, `ended_at`, `legs`,
`untrusted_fields`, `artifacts`, `similarity_hint`, `divergence_prompt`,
`judge`, `judge_orders_agree`, `cancel_source`, `orphan_suspected`,
`kill_report`, `reason`, `text` and `answers_in`. Judge detail fields appear
when applicable. `text` contains `included`, `offset`, `max_chars`, and
`per_leg` paging metadata (`leg_id`, `total_chars`, `chars_returned`, `offset`,
`truncated`). Actual answer text stays in the untrusted screen blocks.
Leg records include backend/model/account, state, usage, timing, estimated
cost and available failure/cancellation diagnostics. A similarity hint measures
wording overlap, not correctness or agreement.

## council_ask

Required `prompt`. Accepts start arguments except `backends`, `continue_from`,
`idempotency_key` and `force_round`; instead `backend` is one backend and
defaults to `claude`. `timeout_s` has schema bounds 30-900 and default 300,
and can only lower the selected class timeout. `max_cost_usd` likewise only
lowers the class budget. `stakes:"high"` does not add a vendor for ask.

Returns a terminal poll payload if finished within the blocking window;
otherwise returns a start payload with `degraded:true`, `ask_degrade_reason`
and `blocked_s`. Defaults allow up to 110 seconds only for a `claude-code`
host with absent or matching client name, and 40 seconds for other hosts or
a client-name mismatch. Configuration can change these timing values.
Use start/poll for long work. Cancelling an ask request also cancels its job;
cancelling a poll request only ends that wait.

## council_cancel

Required `job_id`; optional `reason` (up to 300 characters) and `cascade`
(boolean, default true). Returns the cancellation record with `job_id`,
`state` and applicable identity/kill diagnostics, `already_terminal`,
`orphan_suspected` or child results. It is idempotent for terminal jobs.
Missing jobs use the not-found shape. A surviving process is an error/orphan
report, not proof of cancellation.

## council_list

Optional `state`: `any` (default), `running`, `terminal`, `done`, `partial`,
`error`, `timeout`, `cancelled`, `lost`, `refused`; `since_hours`: 1-720
(default 24); `backend`: one backend; `limit`: 1-200 (default 25).

Returns `since_hours`, `state_filter`, `count`, `running`, `lost`,
`lost_unverified` and newest-first `rows`. Rows include job ID, time, state,
class, backend legs, elapsed time and label. At most five lost candidates per
call receive identity checks. Use it to recover a job ID after a host restart.

## council_search

Required `pattern` (1-500 characters). Optional `regex` (false), `path`
(up to 260 characters), `glob` (up to 5 strings of at most 100 characters),
`mode` (`content` default, `files`, `count`), `context` (0-5, default 1),
`max_results` (1-300, default 60), `include_jobs` (false).

Success payload: `ok:true`, `pattern_preview`, `mode`, `regex`,
`include_jobs`, `matches`, `total`, `truncated`, `elapsed_ms`, `rg_exit`,
`untrusted_matches`. Content matches include `file`, `line`, `text`,
`before`, `after`; file/count modes can use a null line and a count.
Job-output matches are flagged and framed as untrusted. Failures contain
`ok:false`, `reason` and applicable details such as the expected ripgrep path.
No JavaScript fallback scanner exists. Paths must stay within allowed vault
data; `include_jobs` is explicit permission to search job output.

## council_doctor

Optional `deep` (boolean, false). Deep adds version probes, not model calls.
Returns `ok`, `mode`, `council_version`, `server_pid`, `host`,
`client_claimed`, `depth`, `profile`, `config`, `vault`, `sandbox_root`,
`stop_files`, `app_dir`, `integrity`, `layout`, `reaper`, `pending_hosts`,
`backends`, `rg`, `fuses`, `jobs`, `ledger`, `accounts`, `child_env`,
`warnings`, `gemini`, `agy`, `gemini_enabled`, `vault_config_ignored`,
`npm_root_ignored` and `proxy_env_ignored`. With resolved paths it also adds
`cancel_timings` and `prune_hint`. `config` includes `expanded` and
`prompt_form` as well as its path and trust report. Some values are null when
paths cannot be resolved. `config.trust` includes `ok`, `binaries_ok`,
`forbidden_flags_source`, `failures` and `allowed_roots`. Backends report
path/existence/availability/reason/account plus version and probe details
when available. Diagnostic reads do not prove host wiring or vendor sign-in.

## council_ledger

Optional `window`: `hour`, `day` (default), `week`, `month`; `group_by`:
`account` (default), `backend`, `host`, `task_class`; `include_refusals`:
boolean, default true. Returns `window`, `from`, `to`, `group_by`, `groups`,
`by_host`, `top_wall`, `refusals`, `quota_snapshot`, `plan_usage_inferred`,
`unparseable`, `legs`, `rows_scanned`, `files` and `footer`.
Costs and inferred usage are not a vendor invoice. See [PRICING](PRICING.md).

## Installer command line

Use `bin\council-setup.cmd <verb> [flags]` or
`node installer/setup.mjs <verb> [flags]`. `--help`/`-h` prints usage.
Global flags: `--profile <id>`, `--json`, `--no-color`, `--verbose`,
`--log <file>`. Profile IDs match `^[a-z0-9][a-z0-9_-]{0,31}$`.
`--log` writes a new file under `etc/logs` on completed normal apply paths,
including unchanged apply; invalid or existing targets refuse with `E-USAGE`.
Apply dry runs and migration recovery do not write it. Detect, duplicates and
new-task suppress it with a `log` result reason; plan adds a warning; other
verbs ignore it. `--no-color` is accepted but inert. `--verbose` adds error stacks.
Arguments are separate tokens,
not `--key=value`. Only `new-task` takes a positional argument.

| Verb | Accepted verb-specific flags |
|---|---|
| `detect` | `--vault <path> --duplicates --out <file>` |
| `plan` | `--vault <path> --merge block/sidecar/none/ask --conventions --relocate-runtime --hosts <list> --register-as <name> --owner <text> --chat-language <text> --answers <file> --large-vault --git-init --allow-unsupported-platform --duplicates` |
| `apply` | `--plan <file>` (required), `--yes --resume --dry-run --no-register --adopt-existing` |
| `verify` | `--fast --full --hosts` |
| `update` | `--channel <git or zip> --ref <ref> --keep <count> --check --prune-versions --rollback [version]` |
| `uninstall` | `--all --keep-app --keep-vault --purge-runtime --purge-backups --yes`; requires input/output TTY; `--yes` cannot accompany either purge flag |
| `install-prereqs` | `--node --claude --codex --print-only` |
| `login` | `--only <claude or codex or gemini>` |
| `migrate` | `--from <old directory> --phase <0 to 3> --host <surface> --dry-run --rollback` |
| `rollback` | `--journal <timestamp>` (required), `--yes` |
| `set-key` | `--delete` |
| `duplicates` | `--vault <path> --max-files <1..200000> --out <report file>` |
| `new-task <slug>` | `--vault <path> --agents claude,codex,gemini` |
| `unlock` | `--force-unlock` (required) |

Host surfaces are `claude-code`, `claude-desktop`, `codex`; the hosts option
also accepts `none` or `all`. Migration phase 2 requires one `--host` and
enforces cutover order: `codex`, `claude-desktop`, then `claude-code`.
Migrate requires `--phase` or `--rollback`. New-task agents default to the
detected usable CLIs, not all three names.

Plan obtains vault, owner, chat language, merge and hosts from CLI flags,
answers or interactive questions/defaults; those flags are not mandatory.
`--merge ask` only prompts on a TTY without `--answers`/`--json`; otherwise
it falls back to block, including scalar `ask` in an answers file. Per-file `ask` becomes block. An interactive scalar
answer `ask` is refused when the planner reaches a file requiring a decision.
Duplicate report output is constrained to `etc/reports`; detect's `--out`
must be a new file outside the vault, app and host configurations, with an
existing parent directory. Explicit
CLI flags override answers-file values. `apply --adopt-existing` confirms
compatible legacy host entry adoption; `--no-register` defers registrations
and must remain consistent on resume. Verify inspects recorded registrations;
Tier 0 runs only after earlier drift checks pass, and live stdio host probes
run only if no drift remains after Tier 0. Its default is the fast selection,
`--full` broadens it, and the accepted `--fast`/`--hosts` flags add no behavior.
`update --keep` defaults to 2 for pruning;
`--rollback` without a version selects the recorded previous version.

## Installer JSON and exit codes

`--json` selects a compact result object for the verb, not an MCP envelope
or a universal `{ok,data}` wrapper. Verify, uninstall, update, install-prereqs,
login, set-key and migrate already print JSON without the flag; it compacts
their result. Rollback also prints JSON in both modes. Uninstall, login,
install-prereqs and set-key write attended prompts/progress to stdout, so
stdout under `--json` is not necessarily a single JSON object. JSON mode does
not authorize unattended login, prerequisite installation or key deletion.
Result variants include:

| Verb | Principal result fields (optional fields depend on the path taken) |
|---|---|
| `detect` | `schema:1, verb, profile, blocks, warnings, exitCode`, optionally `duplicates, log`; blocks contain named facts and `errors` |
| `plan` | `schema:1, verb, profile, created_at, file, answers, detect_fingerprint, steps, registrations, pending_hosts, untouched, warnings, adoptions, proposals, transplanted, layout, cloud_sync, skill, file_sha256`, optionally `duplicates`; saved plan omits its own hash field |
| `apply` | `profile, changed, registrations, backups, warnings, pending_hosts, journal, proposals, tier0, exitCode`; unchanged runs add `unchanged, verified`; dry run returns `dryRun, plan`; migration dry run returns `migration, dryRun, phase, operations` |
| `verify` | `profile, drift, warnings, registrations, created, cleanup_left, notice, note, trust, agy, tier0, exitCode`; refusals add `reason` with `exitCode:4` |
| `update` | `changed, kept, proposals, warnings, exitCode`; variants add `available`, `unchanged`, source/version or refusal details |
| `uninstall` | `profile, removed, skipped, scope, backups, exitCode`, plus `software` on completed removal or `reason` on refusal |
| `install-prereqs` | `items, exitCode`; each item has `item` and `installed`, `declined`, `printed` or `skipped`/`confirmed` |
| `login` | `steps` with kind/skipped and applicable store/login status, `exitCode` |
| `set-key` | `stored:true, last_four, exitCode:0`, or `removed, exitCode` for deletion |
| `migrate` | `exitCode`, usually `phase`, plus `changed`, `registered`, `journal`, `host`, `leftovers`, `unchanged`, `rollback`, `plan`, `steps`, `next` or dry-run operations as applicable; declined confirmation omits `phase`, as does an open-journal dry run (`dryRun, open_journals, exitCode:5`) |
| `rollback` | `restored, conflicts`, with `exitCode` and/or `unchanged` |
| `duplicates` | `schema:1, verb, vault, files, hashedBytes, capped, groups, notHashed, indexRepeats, notice, reportFile` |
| `new-task` | `schema:1, verb, path, agents, files, indexAppended` and optional `note` |
| `unlock` | `ok` and any refusal/recovery details |

Thrown errors emit `{error:{code,exitCode,what,why,fix,detail},exitCode}`;
`--verbose` adds `error.stack`. If a plan report was already printed, its
publication error goes to stderr rather than becoming a second stdout result.
Some successful result variants omit `exitCode`; process exit is still 0.

| Exit | Meaning |
|---|---|
| 0 | OK |
| 1 | Step failed |
| 2 | Usage/precondition |
| 3 | Stale plan |
| 4 | Conflict |
| 5 | Setup lock (`E-SETUP-LOCKED`), open journal or declined confirmation |
| 6 | Unsupported platform |
| 7 | Verify drift, leftover verify-ledger files or `E-VERIFY-SLOW` |

See [INSTALL](INSTALL.md) for recovery actions, [SPEC](SPEC.md) for ownership
and journal rules, and [MIGRATION](MIGRATION.md) for migration phases.
