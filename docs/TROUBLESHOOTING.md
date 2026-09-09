<!-- Owns runtime troubleshooting; specification §§5–6. -->
# Runtime troubleshooting

Run council_doctor first. It shows the selected profile and vault, running app directory,
integrity result, resolved layout and configuration failures. A missing profile requires
`plan --profile <id> --vault <folder>`, followed by
`apply --profile <id> --plan <saved-plan> --yes`. An integrity failure
requires restoring a verified installation; editing its manifest is not a repair.

Gemini uses the API provider by default. Supply COUNCIL_GEMINI_API_KEY in the server's own
environment or use the OS store through the installer. Without configured pricing,
Gemini API cost estimates are unavailable and its spend is cost-uncapped.

HTTPS_PROXY, HTTP_PROXY, NO_PROXY and NODE_EXTRA_CA_CERTS are forwarded only to the Gemini
API child. The three proxy values must be HTTP or HTTPS URLs under the current contract;
NO_PROXY identifies a host to bypass, rather than accepting the usual comma-separated
syntax. CA files must be readable, absolute, and outside every vault and runtime root.
Rejected settings appear as proxy_env_ignored plus the variable name, never its value.
Configure Claude and Codex proxy behavior through their own supported configuration
outside council. Their council child environments do not receive these four variables.

CLAUDE_CONFIG_DIR is not forwarded. The Claude child uses its default configuration and
credential location; a relocated sign-in can therefore appear absent.

A smoke run suppresses the periodic reaper. Doctor reports
`reaper: suppressed (COUNCIL_SMOKE_RUN)`. Ledger prefixes change filenames only.

## Interrupted installation

Use `apply --plan <the same plan> --resume` to finish an open transaction, or
`rollback --journal <timestamp>` to undo it. Recovery compares current bytes with
the journal's before and expected hashes. A third state is left for human review.
Do not edit the journal to force recovery. A live setup lock is never stolen;
the existing `unlock --force-unlock` command handles an old, uninspectable owner.

Every edited vault and host file is copied first to
`etc/backups/<profile>/<timestamp>/`. Host pre-images use `hosts/<surface>/` mirrors.
The apply report lists each backup's exact path. Host backups are for human recovery:
automatic rollback restores only the recorded MCP entry or TOML table, preserving
other servers and application state written since installation.

`backup_acl_not_restricted` means the backup remains readable but is protected only
by the surrounding local application-data profile permissions. The installer keeps
the backup and reports the warning; it does not silently skip backup creation.

S7 runs Tier-0 against the installed application with an isolated temporary profile.
A failed run retains its `council-smoke-*` directory and prints its path. A successful
run removes only that recorded temporary tree. No hosts are registered before S7 passes.
Each host then receives its own stdio initialization and doctor round trip. Fully quit
and relaunch Claude Desktop after registration. Sign-in remains a separate human step.

For an apply log, choose a new file under `etc/logs/` with `--log <file>`.
`apply --dry-run` prints the saved plan without running the write probe.
`--no-register` installs the local profile and lists the deferred hosts in the report.
Adopting an existing council server entry additionally requires `--adopt-existing`;
`--yes` confirms the plan only. Unrelated registrations are never adoptable.
