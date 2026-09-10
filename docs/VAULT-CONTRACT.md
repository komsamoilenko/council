# Vault contract

## Required pieces and optional conventions

A vault is your chosen notes directory. Runtime authority comes from the
installed profile outside it. A normal fresh installation adds `AGENTS.md`,
`CLAUDE.md`, `work/` and `.council/vault.json`; jobs and ledger default to
`work/jobs/` and `ledger/`. They can be relocated through [CONFIG](CONFIG.md).
Existing contracts can be adopted without imposing every fresh-vault convention.

Conventions default on for a fresh or empty vault; answers-file
`conventions:false` turns them off. `--conventions` forces them on for an
existing vault. They add `INDEX.md`, `inbox/`, `shared/`, `output/` and the shared
debate prompt when absent. Existing index and shared content are preserved.
Git initialization is an explicit choice; `.gitignore` receives council's
marked lines when the vault uses Git or initialization is selected.
No executable code or `bin/` tree is installed inside the vault.

## Adopt in place

Council does not move, rename or delete existing notes to make them fit a layout.
It reports duplicates without removing them. `plan` declares changes before
`apply`; every edited pre-existing file receives a whole-file backup outside
the vault. Modified whole-file owned content is kept with a
`.council-new.<timestamp>` proposal. Edited marker blocks instead produce an
untimestamped `.council-new` proposal; an existing proposal refuses the next
run with `E-SIDECAR-EXISTS`. The generated `*.council-new.*` ignore pattern
does not cover that untimestamped name.

Choose a block merge, a sidecar (`AGENTS.council.md`), no merge, or an attended
choice. `--merge ask` prompts only on a TTY without `--answers` or `--json`;
otherwise it uses the default block strategy, including scalar `ask` in an
answers file. Per-file `ask` values become
`block`. An interactive answer of scalar `ask` is refused when the planner
reaches a file requiring a merge decision. An existing unmarked council protocol can cause a no-merge decision.
Read the plan's WILL NOT TOUCH and warnings sections before applying it.
Cloud-only contract files must be hydrated before their contents can be hashed.
Links and reparse points are refused at managed write targets.

## The path-free pointer

`.council\vault.json` records `schema`, `profile`, `vault_id`,
`contract_version`, `app_version`, `installed_at` and `note`. Existing extra
user keys are preserved. It contains no executable paths or credentials and
may travel with Git. It is **never read for authority** by the runtime.

The installer can use its presence to discover a vault and its identity to
recognize adoption or transplantation. Changing it does not select a runtime
binary, redirect a profile, or make copied machine configuration trusted.
Install a local profile for a cloned vault. The generated `.gitignore` block
has six fixed lines, independent of a relocated layout:

```text
work/jobs/
ledger/
STOP
.council/.write-probe
*.council-new.*
*.council-tmp-*
```

`.council/` itself is not ignored. The planner does not use the parameterized
gitignore template; relocation does not change these six lines.

## Marker blocks

Markdown blocks are written as:

```text
<!-- council:begin v=1 -->
generated content
<!-- council:end -->
```

The reader also accepts an unversioned begin marker. `.gitignore` and TOML use
`# council:begin v=1` and `# council:end`, also accepting an unversioned begin.
Unknown versions, duplicate blocks, unbalanced markers and an unterminated
code fence are conflicts (the latter refuses the whole file with
`E-MARKER-FENCE-UNTERMINATED`, exit 4).
Markers inside fenced code are ignored. The installer preserves BOM, dominant
line endings and bytes outside the managed block, checking the latter after
writing. Block hashes are normalized for line endings and recorded in the
external manifest; markers carry neither a profile ID nor a trusted hash.

## Conditional rules

The rules renderer has exactly two conditional flags, with no nesting:

| Flag | Condition | Effect |
|---|---|---|
| `INDEX` | An index exists or conventions will create one | Include instructions for registering output in the index |
| `CONVENTIONS` | Conventions are enabled, including the fresh/empty-vault default | Available to conditional templates; the planner also uses the choice to create optional layout content |

The current whole-file rules template uses `INDEX` for its conditional sections;
task-folder instructions are unconditional. The generated layout names existing
or planned top-level paths. Task-folder
names and placeholder paths describe future conventions, not existing files.
Use `council-setup new-task <slug>` for a task folder. Rules are guidance an
agent can edit, not a security boundary. The Antigravity adapter remains
disabled; see [NOTICE](../NOTICE.md).

## What council never touches

Council does not rewrite note bodies, reorder index entries, prune duplicate
files, alter `.obsidian` settings, or install executable scripts in your vault.
It does not use an old in-vault configuration to authorize execution. Uninstall
is limited by the external manifest: user-modified files and nonempty user
directories are retained. Jobs, ledger and other user history are not a general
cleanup target. See [SECURITY-MODEL](SECURITY-MODEL.md).
