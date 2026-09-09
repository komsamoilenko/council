# Cancellation timing

`council_cancel` returns `cancel_timing`. The server also records it in a
`reaper_action` ledger row with `action: "cancel_timing"`. A deep
`council_doctor` response exposes the latest five such rows from the last 24 hours
in `cancel_timings`.

- `total_ms`: elapsed server cancellation handling time, before diagnostic ledger
  publication and response rendering. T-06 separately records client wall time.
- `verified_dead_ms`: elapsed time at completion of the existing runner and child
  verification steps; null when the result does not establish all reported targets
  dead. This records the existing verification outcome, not an additional process
  enumeration or a stronger guarantee about unreported descendants.
- `taskkill_ms`: cumulative server-side `tree_kill` helper time.
- `death_poll_count`, `death_poll_ms`: number and cumulative duration of liveness
  calls inside server-side `waitForDeath`.
- `stages`: server observations `{stage, pid?, ms}`. Stages are `grace`, `identity`,
  `tree_kill`, `liveness`, `death_poll`, and `wait_for_death`. `tree_kill` measures
  the forceful tree-termination helper, excluding death verification.
- `runner`: completed runner observations with the same stage shape, read from
  `state.json.cancel_timing`. These can overlap server grace and kill work and must
  not be added to server wall time. An interrupted helper has no completed timing.

Durations use a monotonic clock. `death_poll` includes its nested `liveness`
observation; `wait_for_death` includes polls and sleeps. These nested observations
must not be summed as independent stages. Runner timings are also included in its
terminal kill report when it finishes normally.

T-06 prints client duration and the complete timing object on passing and failing
assertions. `T-06-diagnostics` exercises the production cancel and platform code
with simulated helpers, without process-table access or vendor calls. Its timings
are instrumentation validation only, not Windows latency evidence. The original
T-06 still requires live process inspection and retains its 8,000 ms bound and all
tree-death assertions.

Acceptance should run `node tests/run.mjs` three times with live Windows process
inspection, retain each T-06 timing line, and identify the dominant stage before
changing cancellation behavior. No latency optimization is justified by simulated
helper timings alone.
