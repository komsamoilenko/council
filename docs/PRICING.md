# Pricing and spend records

## Who pays

Council has no service fee or account of its own. It drives vendor CLIs you
already pay for and the Gemini API using your own key. A consultation can
consume subscription quota or incur API charges under your vendor agreement.
Council does not quote current vendor prices; see [NOTICE](../NOTICE.md) for
service and terms links. The Antigravity adapter is disabled; see [NOTICE](../NOTICE.md).

## Fuses are usage bounds

| Fuse | Default | What it counts |
|---|---|---|
| `max_per_hour` | 20 | Reserved legs in the rolling last hour |
| `max_per_day` | 80 | Reserved legs in the rolling last 24 hours |
| `max_running` | 3 | Concurrent live legs across a profile's hosts |
| `max_depth` | 2 | Consultation recursion depth; children receive depth plus one |

One three-leg fan-out consumes three reservations. Reservations use a shared
lock and either reserve the entire fan-out or refuse it. Failed spawns can
append compensating release records. Configuration and the trusted server's
fuse environment settings control limits; [CONFIG](CONFIG.md) describes where
configuration belongs. STOP files, deadlines, prompt limits and cancellation
also limit runaway work.

`max_cost_usd` is the Claude leg's budget parameter, not a cross-vendor spending
cap. Gemini without configured pricing is explicitly reported as cost-uncapped.
Reported costs can be estimates or unknown; a cancelled or failed consultation
can still have spent quota. Read-only sandboxes do not make model calls free.

## Ledger

Monthly `council-YYYY-MM.jsonl` files are the local spend record: job/leg events,
host, backend, model, account label, token usage, elapsed time, estimated cost,
refusals and cancellation diagnostics. The default location is your vault's
`ledger/`; relocation puts it under the profile runtime root. The runtime
appends rather than rewriting history. Malformed rows are counted and skipped;
write failures are reported through ledger health/error records.

Labels group records and never choose vendor credentials. The ledger is not
a vendor invoice or a tamper-proof audit log, especially if an agent can write
its directory. Vendor dashboards remain the authority for billed usage.

## Inspect with council_ledger

```json
{"window":"day","group_by":"backend","include_refusals":true}
```

Pass this to `council_ledger`. Windows are `hour`, `day`, `week`, `month`;
groupings are `account`, `backend`, `host`, `task_class`. The report includes
aggregates, top wall-time consumers, refusals, parse-error counts and the newest
available Codex quota snapshot. Inferred plan usage and snapshots are labeled
as such and can be stale. Ledger inspection makes no model call.

## Zero-quota path

Use `council_start` with `backends:["echo"]` to exercise job creation and
polling locally. Echo is a fake backend and needs no vendor account, network
model request or paid quota. The local test gate uses isolated fixtures and
echo/test doubles. `council_doctor` is also zero quota. Prerequisite downloads
and `set-key` validation are separate network operations, not echo tests.
