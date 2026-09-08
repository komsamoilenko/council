<!-- Owns machine/profile configuration guidance; specification §4. -->
# Configuration

The running app reads machine.json and profiles/<id>/config.json under its local
application-data etc directory. COUNCIL_PROFILE selects the profile; default is used
when absent. Names contain lowercase letters, digits, underscores or hyphens and start
with a letter or digit, with a maximum length of 32. The runner checks the profile saved
in each job request before spawning a leaf.

The machine owns binaries and the measured global npm root. Profiles own vault,
runtime_root, layout, models, fuses, timing and account labels. Machine binaries replace
profile binary values. The generic account labels are anthropic:default, openai:default,
google:default and local:echo. Account labels describe spend and do not select credentials.

Paths can use platform tokens. COUNCIL_APP always means the running app directory;
COUNCIL_VAULT means the vault after expansion. Environment variables cannot override
those two token values. Unknown or unset tokens refuse configuration. Relative layout
paths resolve against the vault. work_dir, jobs_dir and ledger_dir must stay under the
vault or runtime_root, and outside executable code.

Executable roots are derived from the Node executable directory, system helpers,
vendor-scoped npm subdirectories and the installed app tree. Machine configuration
cannot authorize all of a package root or a writable notes directory. Both lexical
and resolved executable paths are checked. An invalid configured npm root yields
npm_root_ignored and the standard per-user npm location is used instead.

COUNCIL_CONFIG is a test-only override when COUNCIL_HOST is absent or smoke. It never
restores the old in-vault config fallback. COUNCIL_LEDGER_PREFIX changes filenames,
with its existing test-only host rules; COUNCIL_SMOKE_RUN suppresses the periodic sweep.

The launcher reads current.json, validates its version, and loads the selected server
as the main module. It was exercised on Node v24.11.1; older versions remain unverified.
