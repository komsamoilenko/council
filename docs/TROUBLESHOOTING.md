<!-- Owns runtime troubleshooting; specification §§5–6. -->
# Runtime troubleshooting

Run council_doctor first. It shows the selected profile and vault, running app directory,
integrity result, resolved layout and configuration failures. A missing profile requires
`council-setup apply --profile <id>` once the installer is available. An integrity failure
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
