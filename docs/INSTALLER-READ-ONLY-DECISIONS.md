<!-- Owns task 07 specification questions and their implementation choices. -->
# Read-only installer decisions

These choices interpret SPEC.md together with SPEC-AMENDMENTS.md. The foundation
modules are unchanged. A-03 remains deferred to task 08.

1. **Brief's blanket vault-write prohibition versus §7.13.** `new-task` is the
   explicit exception: it creates task files and optionally appends the existing
   index. It never installs code in the vault.
2. **§7.1 and brief: detect writes nothing; §10.2: detect --duplicates reports.**
   Ordinary detection writes nothing. Explicit `--duplicates` enables only the
   duplicate report; explicit `--out` enables a new survey JSON file outside the
   vault, app and host configurations. Neither option overwrites an existing file.
3. **§7.1's plan flag table omits --duplicates.** The invariant and §7.3 explicitly
   permit it, so the flag and the duplicate-scan answer are both accepted.
4. **§7.1, §7.3 and §10.2 give different duplicate filenames.** The dedicated
   §10.2 rule wins: `duplicates-<profile>-<timestamp>.md` under `etc/reports`.
   `duplicates --out` must stay under that directory and outside the vault.
5. **Global --log versus the exhaustive write allowlist.** The flag is accepted
   on every implemented verb and its suppression is reported. It writes no log.
6. **Closed exit codes versus deferred verbs.** No fake verb makes code 7
   reachable: it belongs to verify. The suite exercises its error-catalogue
   producer, while code 3 additionally exercises the real shared stale-write
   guard. Codes 0, 1, 2, 4, 5 and 6 have read-only command paths. Unsupported
   future verbs always return 2 and say they are not in this build.
7. **§10.3's not-a-directory refusal versus §11 case 2a's new vault.** An absent
   directory is a permitted future vault if its nearest existing ancestor is a
   directory and all root checks pass. Plan resolves through existing ancestors
   without creating any part of the vault. Existing files remain refused.
8. **§7.3 does not define an answers-file schema.** It is a JSON object using
   flag-style keys; the eight questions are vault, owner, chat-language, merge,
   relocate-runtime, gemini-key, duplicates and hosts. Merge can be an object
   keyed by contract filename. Desktop selection is `desktop-config`, or part
   of the single interactive hosts answer. Unknown keys are refused. CLI flags
   override answers. `gemini-key: now` records intent for the later set-key verb;
   plan never requests, retains or writes an actual key.
9. **§7.2 does not give exit policy for every missing optional tool.** Missing
   Git, npm or vendor CLIs are reported; unavailable hosts are pending. Node's
   floor blocks. An old Claude is unusable and gets an upgrade warning. Codex's
   unverified numeric floor is not invented: help and acceptance of
   `--ignore-user-config --version` are both checked. Agy stays disabled.
10. **§7.2's full non-Windows survey versus §11 case 1d's platform refusal.**
    Detection completes every block and returns 6 for the first platform
    failure. Only plan's explicit unsupported-platform override waives that
    failure. Later failures cannot replace an earlier block's exit code.
11. **§7.3 leaves fingerprint serialization and plan checksum representation
    unspecified.** Inputs are canonically serialized with sorted JSON keys.
    JSON host entries are hashed canonically; TOML uses the selected table span.
    Host live state and other servers are excluded. The report checksum hashes
    the exact saved plan bytes; `--json` adds `file_sha256` as report metadata
    outside the stored plan document, avoiding a self-referential hash.
12. **§7.3 asks for sizes, but §7.4 creates apply-time records and live host
    merges.** Known files have exact byte sizes and directories have zero file
    bytes. Lock, journal, machine/profile manifest and live JSON registration
    sizes are explicitly `size determined by apply`; no guessed size is stated
    as exact. These remain ordered generated-write descriptions for task 08.
13. **§11 case 2d lists S3–S5/S8 but also requires a vault pointer refresh.**
    Transplant plans include S6 solely for the path-free pointer and necessary
    parents. They omit ordinary vault scaffolding and the write probe because
    case 2d's explicit vault-write limit wins over the general S0 description.
14. **§8.2's ask/none/sidecar strategies do not define unattended or absent-file
    behavior.** `ask` uses the block default unattended. Strategies apply to
    conflicts: absent files still receive the minimum contract. Existing
    protocol text defaults to none. Unknown/edited blocks return 4 without a
    proposal file or plan publication; none/sidecar are reviewable alternatives.
    No new allow-rewrite flag is invented. The existing foundation API owns
    explicit approved rewrites and canonical marker upgrades.
15. **§7.13 leaves dates, slug collisions and agent eligibility unspecified.**
    Dates use UTC. Slugs must be bounded kebab-case and cannot be Windows device
    names. Existing task directories are refused, never overwritten. Default
    agents are usable detected CLIs; Gemini can be explicitly requested. Index
    matching compares the exact backtick-delimited relative task path, allowing
    one trailing slash. Absent INDEX.md stays absent; verbose alone explains it.
16. **§7.2's npm commands have undocumented write side effects.** Inspection of
    the installed npm source showed cache mkdir, log creation/pruning and an
    update notifier. Probes use existing TEMP as cache, the existing Node file
    as a deliberately non-directory log destination, zero retained logs, and
    disabled timing/update checks. This prevents those incidental writes and
    cleanup; probes still run as absolute Node plus npm-cli.js, without a shell.
17. **§7.3's second-resolution filename examples permit collisions.** Filenames
    include UTC milliseconds; publication is exclusive. An existing filename
    produces an actionable refusal rather than overwriting an earlier plan.
18. **§10.2 does not specify Git-ignore evaluation when Git is unavailable.**
    Git's read-only `check-ignore --no-index` is authoritative when it works,
    including repository/global exclusion rules. Without it, a local matcher
    handles nested `.gitignore` files, negation, anchoring and glob patterns.
    It does not claim to read Git configuration it cannot query. Both file and
    hash-byte caps still apply, and links/placeholders are never followed.

The tests keep their mkdtemp roots inside the repository's `tests/tmp` to respect
the task's write boundary. Each child exports that root as TEMP and exports all
home/config variables beneath it, checks isolation before importing the test
body, and replaces the process-probe boundary. No vendor binary or network runs.
File hashes and mtimes plus the complete path inventory are compared over the
entire sandbox. Existing directory mtimes are excluded because publishing an
allowed child necessarily changes its parent's directory mtime.

`node --check` applies to JavaScript files. The PowerShell wrapper is checked
with its parser; the cmd wrapper uses cmd's ordinary launcher syntax. No Node
syntax check is claimed for shell scripts or this Markdown file.
