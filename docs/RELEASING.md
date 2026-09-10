# Releasing council

This is a human-run publication procedure. Building the tools or staging a tree
does not authorize a push, a tag or a release. The release is a tag on `main` in
the existing public repository. Run these PowerShell commands from that checkout.

```powershell
node tests/run.mjs
```

The gate must exit 0. These are local tests with isolated temporary profiles and
no vendor quota. Then re-open the four vendor pages below, review them against
`NOTICE.md`, and refresh its **Vendor terms checked** date:

- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal%2Dand-compliance)
- [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/)
- [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms)
- [Antigravity Additional Terms](https://antigravity.google/terms/)

Follow the related policy and FAQ links in NOTICE as needed. Do not refresh the
date without checking the pages. Commit the refreshed NOTICE and intended release
inputs on `main` using your normal review process, then stage the clean tree:

```powershell
node tools/stage-release.mjs --inventory-only
node tools/stage-release.mjs --out "$env:TEMP\council-public" --version 0.1.0
```

Use a new output directory with an existing parent outside the repository. Existing
targets, repository descendants (including paths resolved through junctions), and
mismatched versions are refused. Staging refuses a dirty working tree, including
untracked files, and independently runs the full gate again; a prior green run is
never sufficient. The inventory is exactly `git ls-files`, with no hand-written
allowlist or exclusions. `.gitignore` keeps fixtures and logs out of the tracked
tree; the scanner checks whether that tree is publishable. `--inventory-only`
prints one tracked path per line without running the gate or writing anything.
Run `node tools/stage-release.test.mjs` for both scanner and staging regressions.

Keep the staging output as evidence. The tool scans the copied tree, writes
`STAGED.json`, then scans the complete output again, including that metadata,
without exemptions. Every hit is printed and causes refusal. Failure leaves the
output for inspection; the tool never deletes or overwrites a prior tree. Its own
writes are confined to the output; the gate uses its usual OS-temp fixtures.

`STAGED.json` records the version, full source commit, total file count including
itself, and a reproducible tree hash. Commit and tree digest use colon-separated
hexadecimal bytes: remove the colons to recover ordinary hex. This permits scanning
the metadata without treating a digest as an opaque secret or exempting a file.
The tree hash is SHA-256 of UTF-8 JSON containing sorted
`[relative/path, sha256HexOfBytes]` pairs, followed by LF. Paths use `/` and ordinal
string order. Only `STAGED.json` itself is omitted from the hash to avoid
self-reference; it is included in the count and the scanner.

Verify that `git rev-parse HEAD` equals `STAGED.json.source_commit` with its colons
removed, and that you are still on `main` at that clean commit. Tag that commit:

```powershell
git tag -a v0.1.0 -m "council 0.1.0"
git push origin v0.1.0
```

The annotated tag names the existing release commit; the push publishes that tag.
Each command must succeed before proceeding to the next. Create `dist` if absent:

```powershell
New-Item -ItemType Directory -Path dist
git archive --format=zip --prefix=council-0.1.0/ -o dist\council-0.1.0.zip v0.1.0
node tools/sha256.mjs dist\council-0.1.0.zip > dist\council-0.1.0.zip.sha256
```

The zip and staged tree contain the same tracked tree at the same commit, with
`STAGED.json` present only as local staging evidence. Check that
`STAGED.json.file_count` minus one equals the zip's file entries (exclude directory
entries), and compare their relative paths after removing `council-0.1.0/` from
zip paths. `git archive` packages the tag with that single versioned top-level
directory; it does not package uncommitted files or `dist` itself.

`sha256.mjs` prints only a lowercase SHA-256 digest and LF. The updater reads the
sidecar's first whitespace-delimited token and verifies the downloaded zip before
unpacking it. Use PowerShell 7 for the redirect above. In Windows PowerShell 5.1,
which redirects native text as UTF-16, use this ASCII-safe equivalent:

```powershell
node tools/sha256.mjs dist\council-0.1.0.zip | Set-Content -Encoding ascii dist\council-0.1.0.zip.sha256
```

```powershell
gh release create v0.1.0 dist\council-0.1.0.zip dist\council-0.1.0.zip.sha256 --title "council 0.1.0" --notes-file docs\release-notes\0.1.0.md
```

`gh` is optional. Its command creates the GitHub release, uploads the two assets
and uses the prepared release notes. The GitHub web UI or REST API can create the
same release for `v0.1.0`: copy the notes and attach exactly `council-0.1.0.zip`
and `council-0.1.0.zip.sha256`. `STAGED.json` is local evidence, never a release
asset. No npm publication is part of this release.

Hosted CI runs only `node --version` and the Node floor assertion, T-00 via
`node tests/trust/run.mjs --lint-only`, T-24 and T-27 via
`node tests/tier0/lint.mjs`, and `node tests/installer/unit/run.mjs`, on Windows
and Ubuntu. The static entry point reuses the actual T-24/T-27 test bodies without
the smoke harness's process bootstrap. A fresh checkout has no retained fixtures;
any T-27 finding is a failure. Hosted CI never runs the local full gate.
