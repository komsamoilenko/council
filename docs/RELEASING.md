# Releasing council

This is a human-run publication procedure. Building the tools or staging a tree
does not authorize a push, a tag or a release. The commands below use PowerShell;
replace `<owner>` before publication. Run from the source checkout initially.

```powershell
node tests/run.mjs
node tools/stage-release.mjs --out ..\council-public --version 0.1.0
```

The first command must exit 0. The staging command independently runs that gate
again and refuses on failure; a prior green run is never sufficient. These are
local tests with isolated temporary profiles and no vendor quota.

Use a new output directory with an existing parent outside the repository. Existing targets, repository
descendants (including paths resolved through junctions), and mismatched versions
are refused. Staging copies only `src/`, `bin/`, `installer/` with templates,
public `tools/`, `docs/`, `tests/`, `README.md`, `NOTICE.md`, `LICENSE`,
`CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md` and `package.json`. Fixture and
runtime roots, logs, dependencies, private top-level folders and other unlisted
files do not ship. Fixture generators and inert test helpers remain test source.
The public tool list is explicit in `tools/stage-release.mjs`.

The tool runs the existing personal-data scanner over the copied tree, prints
every hit and refuses if any exists. It writes `STAGED.json`, then scans the
complete output again, including that metadata, without exemptions. Failure
leaves the output for inspection; it never deletes or overwrites a prior tree.
Its own writes are confined to the output; the gate uses its usual OS-temp fixtures.

`STAGED.json` records the version, full source commit, whether the source checkout
was dirty, total file count including itself, and a reproducible tree hash.
Commit and tree digest use colon-separated hexadecimal bytes: remove the colons
to recover ordinary hex. This permits scanning the metadata without treating a
digest as an opaque secret or exempting a file. The tree hash is SHA-256 of UTF-8
JSON containing sorted `[relative/path, sha256HexOfBytes]` pairs, followed by LF.
Paths use `/` and ordinal string order. Only `STAGED.json` itself is omitted from
the hash to avoid self-reference; it is included in the count and the scanner.
A dirty checkout is labelled honestly: its staged hash describes the actual bytes,
not a claim that those bytes equal the recorded commit.

Before creating the public commit and tag, re-open the four vendor pages below,
review them against `NOTICE.md`, and refresh its **Vendor terms checked** date:

- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal%2Dand-compliance)
- [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/)
- [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms)
- [Antigravity Additional Terms](https://antigravity.google/terms/)

Follow the related policy and FAQ links in NOTICE as needed. Do not refresh the
date without checking the pages. Make this change in the source checkout, commit
the intended release inputs using your normal review process, then rerun staging
into a fresh output directory. This keeps the date in the gated, scanned and
hashed tree; do not edit the staged NOTICE after computing its metadata. If a
different output directory was used, substitute it in the next command.

```powershell
cd ..\council-public
git init -b main
git add -A
git commit -m "council 0.1.0 — MCP server for cross-vendor AI consultations"
git remote add origin git@github.com:<owner>/council.git
git push -u origin main
git tag -a v0.1.0 -m "council 0.1.0"
git push origin v0.1.0
```

Changing directory selects the public tree, not the private development checkout.
`git init` creates its `main` branch; `git add` and `git commit` record exactly that
tree. Adding the remote identifies your public repository. The first push publishes
the branch. The annotated tag names the release commit, and the second push
publishes that tag. Each command must succeed before proceeding to the next.

```powershell
New-Item -ItemType Directory -Path dist
git archive --format=zip --prefix=council-0.1.0/ -o dist\council-0.1.0.zip v0.1.0
node tools/sha256.mjs dist\council-0.1.0.zip > dist\council-0.1.0.zip.sha256
gh release create v0.1.0 dist\council-0.1.0.zip dist\council-0.1.0.zip.sha256 --title "council 0.1.0" --notes-file docs\release-notes\0.1.0.md
```

Create `dist` if absent. `git archive` packages the tag with a single versioned
top-level directory; it does not package uncommitted files or `dist` itself.
`sha256.mjs` prints only a lowercase SHA-256 digest and LF. The updater reads the
sidecar's first whitespace-delimited token and verifies the downloaded zip before
unpacking it. Use PowerShell 7 for the redirect above. In Windows PowerShell 5.1,
which redirects native text as UTF-16, use this ASCII-safe equivalent:

```powershell
node tools/sha256.mjs dist\council-0.1.0.zip | Set-Content -Encoding ascii dist\council-0.1.0.zip.sha256
```

`gh` is optional. Its final command creates the GitHub release, uploads the two
assets and uses the prepared release notes. The GitHub web UI or REST API can
create the same release for `v0.1.0`: copy the notes and attach exactly
`council-0.1.0.zip` and `council-0.1.0.zip.sha256`. No npm publication is part of
this release.

Hosted CI runs only `node --version` and the Node floor assertion, T-00 via
`node tests/trust/run.mjs --lint-only`, T-24 and T-27 via
`node tests/tier0/lint.mjs`, and `node tests/installer/unit/run.mjs`, on Windows
and Ubuntu. The static entry point reuses the actual T-24/T-27 test bodies without
the smoke harness's process bootstrap. A fresh checkout has no retained fixtures;
any T-27 finding is a failure. Hosted CI never runs the local full gate.
