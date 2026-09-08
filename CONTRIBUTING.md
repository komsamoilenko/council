# Contributing

The project is in its scaffolding phase; the port from the working private version lands
before outside changes are practical. Issues and design discussion are welcome now, pull
requests once there is code to change.

## What a change must not break

These are not style preferences. Each one is a decision with a measurement or a paper
behind it; if you want to change one, bring the counter-measurement.

1. **Nothing inside the vault decides what council executes.** The allowed binaries and
   the forbidden flags are hardcoded in source. A config file that lives where an agent
   can write it may only narrow what runs, never widen it.
2. **No prompt on a command line.** Prompts go to the leaves over stdin.
3. **The installer never moves, renames or deletes a user's file.** It adds beside, it
   extends between markers, it backs up before it writes, and it reports duplicates
   rather than resolving them.
4. **The server deletes nothing** except its own expired lock files.
5. **No vendor binary, no vendor code, no vendor credential** in this repository, ever.
   `tools/scan-personal.mjs` fails the build on any personal path, name or account label
   in the release tree, with no exemptions.
6. **A poll answers in under 45 seconds.** Every host abandons a tool call at 60.
7. **The debate stays at two rounds** and keeps "converged but unverified" as a named
   outcome. See the papers cited in `docs/ARCHITECTURE.md`.
8. **Node standard library only** in the runtime. Dependencies are a supply-chain
   surface for a tool that holds an API key and spawns processes.

## Code

- CommonJS in `src/`, one concern per module, a header comment saying what the file owns.
- Windows is implemented; macOS and Linux are honest stubs that refuse loudly rather than
  crash. All OS-specific code belongs in the platform layer, nowhere else.
- Every fix that came from a real failure gets a test that would have caught it.

## Tests

The zero-quota suite must be green before any change is proposed: it drives a real server
over a real stdio pipe with a fake backend, spends nothing, and takes about seven minutes.
Tests must never write to the real ledger — there is an environment variable for that, and
it is enforced.
