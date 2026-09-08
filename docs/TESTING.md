# Testing

Run `node tests/run.mjs` for the local release gate: the 27 ported Tier-0
tests, installer unit tests, installer cases, then trust tests. All four suites run even
if an earlier suite fails. A failed suite makes the gate exit nonzero.
Hosted CI must use the pure unit entry point, `node tests/installer/unit/run.mjs`,
and the static checks described in specification §16.6; it must not run the
local whole gate.

`node tests/trust/run.mjs` executes T-40 through T-50 and T-00 without vendor
calls. Fixtures are isolated installed trees under `mkdtemp` in the system temp
directory and are removed after each test. Process creation and network entry
points are intercepted and counted; T-44 and T-45 assert zero spawns.
T-46 visibly skips with `requires uninstall (task 11)`. The T-50 apply/verify
report assertion also visibly skips until those verbs exist; its ACL recovery
assertions run now. Failures remain failures when a source guard does not meet
the specification. `node tests/trust/run.mjs --lint-only` runs T-00 for hosted
CI, without running the local runtime or installer suites.

`node tests/tier0/smoke.mjs` uses `src/` directly and generates its own
profile, machine file, accounts, source integrity manifest, vault, and state
under the system temporary directory. `COUNCIL_SMOKE_TMP` overrides that base.
Fixtures remain there for failure inspection. No installed profile is loaded.
The vendor executables are inert fixtures; only echo jobs execute. No vendor
quota is used. A readable ripgrep is discovered from PATH or the existing
vendor package, or supplied with `COUNCIL_SMOKE_RG`, then copied into the fixture.

Every test declares its platform requirements. Unimplemented capabilities,
unavailable process inspection, missing ripgrep, and command-line filters print
explicit SKIP lines and count separately from PASS. A partially skipped test
is counted as skipped, while any failed assertion still makes it fail.
The exit code is the number of failed tests, as required by §16.1.
A green gate with skips does not establish the skipped behaviors: inspect the
counts before releasing, especially cancellation, identity, timeout, restart,
STOP, and concurrency cases. Run those on Windows with working process inspection.

The schema-2 port uses an acknowledged temporary agy fixture for in-process
adapter checks, a provider-derived expected image, the specified
`vault_root_not_grantable` refusal, and generic account labels. These reflect
the new specification, rather than weakening the original invariants.
