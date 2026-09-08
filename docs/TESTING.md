# Testing

Run `node tests/run.mjs` for the local release gate: the 27 ported Tier-0
tests, installer unit tests, then installer cases. All three suites run even
if an earlier suite fails. A failed suite makes the gate exit nonzero.
Hosted CI must use the pure unit entry point, `node tests/installer/unit/run.mjs`,
and the static checks described in specification §16.6; it must not run the
local whole gate.

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
