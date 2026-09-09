# Testing

Run `node tests/run.mjs` for the local release gate: the 27 ported Tier-0
tests, installer unit tests, installer cases, then trust tests. All four suites run even
if an earlier suite fails. A failed suite makes the gate exit nonzero.
Hosted CI must use the pure unit entry point, `node tests/installer/unit/run.mjs`,
and the static checks described in specification §16.6; it must not run the
local whole gate.

`node tests/trust/run.mjs` executes T-40 through T-50 and T-00 without vendor
calls. Fixtures are isolated installed trees under `mkdtemp` in the system temp
directory and are removed after each successful test. A failed test prints and
retains its tree, replacing only the previous recorded failure for that suite.
Unit fixtures use a `council-unit-` suite root with failed cases retained together. Process creation and network entry
points are intercepted and counted; T-44 and T-45 assert zero spawns.
T-46 remains skipped until uninstall exists. T-50-report runs a sandbox apply
and checks its ACL warning; the separate T-50-verify assertion remains skipped.
Failures remain failures when a source guard does not meet
the specification. `node tests/trust/run.mjs --lint-only` runs T-00 for hosted
CI, without running the local runtime or installer suites.

`node tests/tier0/smoke.mjs` uses `src/` directly and generates its own
profile, machine file, accounts, source integrity manifest, vault, and state
under the system temporary directory using `mkdtemp`. Repository overrides are ignored.
Fixtures are removed on success and retained, with their path printed, on failure.
A new retained tree replaces only the exact recorded previous tree for that suite,
after checking its ownership, OS-temp parent, prefix, and absence of links.
Installer cases use a `council-sandbox-` temp root with the same lifecycle.
Task-16 plan and status evidence use a separate `council-diagnostics-` temp root;
both paths are printed, and only the latest recorded diagnostic tree is retained.
No installed profile is loaded. Apply S7 passes `--app <installed-version>` to test
the installed code using the same isolated profile harness.
The vendor executable files are tiny non-executable text stubs; refused version
probes are permitted by the doctor assertions; only echo jobs execute. No vendor
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

The installer suite includes apply/rollback cases after the same fail-closed
sandbox preflight as the read-only verbs. It checks declared filesystem changes,
backup canaries and durable backup records, repeat apply and repeat planning,
all twelve stage-boundary resumes, the three incomplete-write recovery states,
S7 refusal before registration, live host neighbors surviving rollback, and a
real installed stdio initialize/doctor exchange. CLI registration probes are
inert test doubles; the real exchange calls only council_doctor. Failure hooks
are injected through the test context, never enabled by an environment flag.
