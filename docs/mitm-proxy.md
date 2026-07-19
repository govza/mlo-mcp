# Debugging MLO sync with mitmproxy

This workflow observes the disposable development profile's MLO cloud traffic
while keeping credentials out of console output. It is for local protocol
debugging only. Do not capture a personal profile or commit capture files.

## Local configuration

The forward proxy listens on `127.0.0.1:8888`. This is deliberately separate
from the local cloud server, which defaults to `127.0.0.1:8080`.

The cloud server's own proxy also writes the same credential-safe structural
summaries for plain-HTTP vendor sync traffic (to
`<stateDir>/soap-summary.jsonl`, see [mcp-cloud.md](mcp-cloud.md)), so routing
MLO through `127.0.0.1:8080` needs no mitmproxy at all unless the sync
operations turn out to be TLS-tunneled — a vendor-host `CONNECT` in that log is
the signal that full mitmproxy interception with the CA certificate is needed.

Runtime files live in the repository's ignored `.mitmproxy/` directory:

- `mlo.flows` contains raw flows and may contain credentials or task data.
- `soap-summary.log` contains the credential-safe structural summaries emitted
  by `mcp-server/scripts/inspect-cloud-capture.py`.
- `mitmdump.log` contains proxy diagnostics.

The inspector only summarizes XML responses from
`sync.mylifeorganized.net`. It prints operation and field names, status codes,
and SOAP actions; it does not print field values. Raw flows remain sensitive.

## Start the proxy

From the repository root:

```powershell
New-Item -ItemType Directory -Force .mitmproxy | Out-Null
mitmdump --listen-host 127.0.0.1 --listen-port 8888 `
  --set save_stream_file=.mitmproxy/mlo.flows `
  -s mcp-server/scripts/inspect-cloud-capture.py
```

For a background session, redirect stdout to `.mitmproxy/soap-summary.log` and
stderr to `.mitmproxy/mitmdump.log`. Confirm the listener with:

```powershell
Get-NetTCPConnection -LocalPort 8888 -State Listen
```

## Route MLO through the proxy

MLO must be explicitly configured to use `127.0.0.1:8888`, or the Windows
proxy must be enabled for the shortest possible capture window. Do not leave a
system-wide proxy enabled after debugging. Before changing it, record the
current Windows proxy settings so they can be restored exactly.

HTTPS interception also requires trusting mitmproxy's local CA certificate.
With the proxy active, open `http://mitm.it/` and install the Windows
certificate for the current user. Remove that certificate when interception is
no longer needed. Never share the CA private key from the mitmproxy user-data
directory.

## Reproduce and inspect

1. Start the local MCP cloud server on port `8080` if the scenario needs it.
2. Start mitmdump on port `8888`.
3. Route only the disposable MLO development profile through the proxy.
4. Trigger one `-QuickSync` operation.
5. Inspect `.mitmproxy/soap-summary.log` first. Treat `.mitmproxy/mlo.flows` as
   sensitive and open it only when structural summaries are insufficient.
6. Add a minimal local handler or fixture for the observed operation, then run
   the unit suite and repeat the single-sync capture.

Authentication bypasses must be local-development behavior, scoped to the
expected host and exact SOAP operation. They must not forward credentials,
disable authentication on non-loopback listeners, or alter production/default
server behavior.

## Stop and clean up

Stop the mitmdump process, restore the previous proxy configuration, and remove
the mitmproxy CA certificate if it was installed only for this investigation.
Delete `.mitmproxy/mlo.flows` when it is no longer needed; raw captures must
never be committed or published.

If MLO reports TLS errors, verify CA trust and the configured proxy. If no flow
appears, MLO is not using the proxy. If the proxy starts but the addon fails,
check `.mitmproxy/mitmdump.log`; the standalone Windows mitmproxy runtime has a
minimal Python standard library, so addons should avoid optional dependencies.
