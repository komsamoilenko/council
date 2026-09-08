<!-- Owns platform support status; specification §3. -->
# Platforms

Windows is implemented. Runtime checks in this port used Node v24.11.1. No older Node
floor is advertised. Process supervision, OS secret storage and file attributes are
explicitly unimplemented on macOS and Linux. Their path resolution, environment,
credential-location and host-config functions are available.

On those platforms the server starts in unsupported-platform mode, answers initialize,
lists all eight tools, and serves doctor, ledger, list and search. New consultations,
active polling and cancellation return platform_not_implemented. Terminal job results
remain readable. No periodic reaper runs.

A future POSIX process implementation must establish PID identity and parentage before
termination and distinguish an inaccessible process probe from a dead process. A future
OS-store implementation can use Keychain on macOS and a session secret service on Linux;
neither is claimed to work in this release. Environment-provided Gemini keys are detected
without invoking an unavailable OS store.
