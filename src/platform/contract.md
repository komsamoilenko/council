<!-- Owns the platform interface and invariants; specification §3. -->
# Platform contract

Every implementation exports the identical key set. Only index.js reads the native
platform identifier. Methods do not resolve system helpers through PATH.

| Surface | Contract |
|---|---|
| id, implemented, notImplementedReason | Identifier, proc/secrets/fileAttributes booleans, refusal explanation |
| appDirs(), homeDir(), tokens() | Machine directories, home and allowed expansion values |
| isAbsoluteNative(p), sameFile(a,b), caseFold(p) | Native absolute-path and identity rules |
| childEnvAllow(), childPath(nodeDir), nullDevice() | Child environment and output sink |
| allowedRootsBase(machine), npmRootInfo(machine) | Derived vendor-scoped roots and rejected npm-root warning |
| systemBinaries(), secretHelper(binaries) | Absolute system paths and selected validated secret helper |
| longLivedChildArgv(), spawnDetachedOpts() | Echo grandchild and detached-process options |
| credentialProbePaths(), hostConfigPaths(), planUsagePath() | Existence-only credential locations, host configs and quota history |
| probe(ctx,pid), inspect(ctx,pid) | Discriminated process probe; compatibility nullable record |
| processNameProbe(name,env) | Read-only absolute helper invocation returning a process count; null when unsupported; a failed probe never means idle |
| isAlive(ctx,pid), livenessOf(ctx,pid) | Boolean observation; alive/gone/unknown distinction |
| verifyRunner(ctx,pid,{jobId}) | Identity-checked runner observation |
| verifyLeaf(ctx,pid,{expectedImage,runnerPid,createdAtMs}) | Identity-checked leaf observation |
| waitForDeath(ctx,pid,ms), treeKill(ctx,pid) | Bounded death verification and tree termination |
| killPid(ctx,pid), childrenOf(ctx,pid) | Single-process forced termination with death verification; direct child IDs, rejecting failed probes |
| fileAttributes(p), isCloudSynced(p), restrictToOwner(dir) | File metadata, evidence-only sync detection, owner restriction with rollback |
| secretPath(name), secretGet(name), secretSet(name,value,writer?), secretDelete(name) | OS store transport, using base64 encoding across the module boundary |
| rgVendorDir(codexJs), expectedImage(name), agyBinaryRoot() | Vendor executable layout and native process names |

Process operations are asynchronous and ctx-first. probe returns found, gone or unknown;
unknown is never proof of death. The nullable inspect wrapper cannot authorize a kill.
ctx.paths.binaries contains validated system executables. restrictToOwner snapshots
permissions, tightens them, checks directory listing and file creation/read/deletion,
and restores the snapshot on failure.

The secret name descriptor carries profile, runtimeRoot and binary. The optional
secretSet writer receives only the encrypted blob and its computed path; the
installer supplies safewrite. secretPath returns the exact single OS-store file. Encoded secret
transport is decoded only inside lib/secrets.js. No secret is placed in helper argv.

Darwin, Linux and fallback implementations supply real paths and environment functions.
Their process, secret and file-attribute operations throw PlatformNotImplemented, with
a readable capability message. The server detects unsupported process supervision before
calling those functions and continues serving its read-only tools.
