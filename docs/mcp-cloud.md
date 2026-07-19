# mcp-cloud: local cloud-sync endpoint for the MLO app

`mcp-cloud` inverts the fragile file-replacement write pipeline (see
[server-architecture.md](server-architecture.md)): instead of closing the GUI and
swapping the `.ml` file, the MCP server *is* the cloud. It runs a local sync
endpoint on `127.0.0.1:8080`; the app's cloud-sync client connects to it, pulls
our deltas, and applies them through MLO's own merge logic. We trigger a session
with the already-verified `mlo.exe -QuickSync`.

The same listener can be configured as MLO's HTTP proxy during development.
Only origin-form requests to the local `/v1/*` API are handled by mcp-cloud;
unrelated absolute-form HTTP requests are forwarded unchanged, and HTTPS
`CONNECT` requests are tunneled end-to-end. This lets initial vendor login and
WSDL discovery proceed without exposing credentials to mcp-cloud.

The **data plane** (envelope bytes, CSV sections, cursor semantics) is fixed by
[cloud-sync.md](cloud-sync.md) and is not renegotiable here. The **wire contract**
below is ours to define — the vendor's field and operation names were
intentionally never part of the implementation contract — and the app-side
client implements this document.

## Roles and state

- The mcp-cloud server is the **cursor authority**. Cursors are signed 64-bit
  logical versions, `bigint` end to end in TypeScript, serialized as decimal
  strings on the wire. They are never derived from wall-clock time.
- The server keeps an **append-only delta log**. Each entry is
  `{ cursor, origin, envelope }` where `origin` is `"mcp"` (authored by an MCP
  tool) or `"app"` (pushed by the app). The high-water cursor is the last
  entry's cursor.
- Cursor values are chosen by the server and are strictly increasing but **not
  guaranteed contiguous** (the observed vendor service also skips values —
  cloud-sync.md's delete experiment). Clients must never assume `+1`.
- A party never receives its own changes back: pull returns only entries whose
  `origin` differs from the caller.

## Wire contract (HTTP/1.1, JSON)

Bound to `127.0.0.1` only (configurable host/port, default port `8080`). All
bodies are `application/json; charset=utf-8`. Envelopes travel as base64-encoded
ZIP bytes. Cursors are decimal strings.

### `POST /v1/pull`

```json
{ "client": "mlo-app", "cursor": "100" }
```

Selects log entries **strictly newer** than `cursor` (and not authored by
`client`), merges them into one envelope:

```json
{ "cursor": "104", "envelope": "<base64 zip>" }
```

When nothing is newer, `envelope` is omitted and `cursor` echoes the current
high-water mark. The returned `cursor` is the high-water cursor represented by
the returned delta; the client persists it as its last accepted server version.

### `POST /v1/push`

```json
{ "client": "mlo-app", "baseline": "104", "envelope": "<base64 zip>" }
```

`baseline` is the server cursor the delta was created against (i.e. the value
the client last accepted). The server validates `baseline <= high-water`
(otherwise `409`), appends the entry at a fresh cursor, and returns it:

```json
{ "cursor": "105" }
```

### `POST /v1/finalize`

```json
{ "client": "mlo-app" }
```

Finalizes the session after pull/push processing (state is flushed to disk).
Returns `{ "ok": true }`.

### `GET /v1/status`

Debug/introspection: high-water cursor, per-origin entry counts, pending
entries for the app. Never returns envelope contents.

Errors are `{ "error": "<message>" }` with 4xx/5xx status; malformed envelopes
(not a ZIP, missing `data.csv`, unsupported `FileVersion`) are rejected with
`400` and are **not** appended to the log.

## Envelope rules (normative, from cloud-sync.md)

- Standard ZIP, one entry `data.csv`, method 8 (Deflate).
- `data.csv`: UTF-8 without BOM, CRLF line endings, begins and ends with a CRLF.
- The full section skeleton is always emitted, even when empty, with the exact
  observed section names, column order, and spellings — including
  `ccChildrenIheritColorCoding` and `ccUnderlineEntireRowthickness`.
- `SysVersions` row defaults to `3,6.1.3,MLO-Windows`; a consumer requires a
  supported `FileVersion` (`3`) before interpreting fields.
- Real CSV reader/writer (quoted commas, doubled quotes, multiline values) —
  never split on commas.
- Changed objects are projected as **full logical records** (all 82 `TodoItems`
  columns), deletions as a single braced uppercase GUID under
  `[TodoItems.Deleted]`.
- Unknown sections and columns are preserved verbatim through parse → merge →
  emit.

### Merging entries into one pull envelope

Applied newest-last over the selected entries:

- `TodoItems` keyed by `UID`: a later full row replaces an earlier one.
- `TodoItems.Deleted`: union; a tombstone also removes any pending `TodoItems`
  row for that UID.
- Other keyed sections (`Places`, `Flags`, relation tables) follow the same
  full-record-wins rule on their key column(s).
- Unknown sections concatenate in log order.

## Persistence

State lives next to the data file, default `<MLO_DATA_FILE>.mcp-cloud\`:

- `state.json` — high-water cursor (decimal string), log index
  (`cursor`, `origin`, filename), the last cursor each origin accepted from a
  pull (`lastPull`, which is what makes "pending for app" counts real), and
  last finalized session info.
- `delta-<cursor>.zip` — one file per log entry, byte-exact as received/emitted.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `MLO_CLOUD_MODE` | `0` | `1` starts the local sync endpoint alongside the MCP server |
| `MLO_CLOUD_HOST` | `127.0.0.1` | bind address (loopback only by design) |
| `MLO_CLOUD_PORT` | `8080` | listen port |
| `MLO_CLOUD_STATE_DIR` | `<dataFile>.mcp-cloud` | delta log + state location |

## MCP tool surface

- `cloud_add_task` — builds a full `TodoItems` row (fresh braced uppercase GUID,
  `CreatedDate`/`LastModified` in MLO's zone-free ISO form), appends it to the
  log as an `origin:"mcp"` delta, triggers `mlo.exe -QuickSync`, then verifies
  the task appeared via a fresh export.
- `cloud_status` — read-only mirror of `GET /v1/status`.

The long-term goal is to route the existing write tools through this path when
`MLO_CLOUD_MODE=1`; `cloud_add_task` is the vertical slice proving the loop.

## Open questions (do not hard-code answers)

- `ItemIndex` semantics for server-authored rows (observed `125` for a fresh
  root task); v1 leaves it empty and records what the app does with it.
- Whether the app consumes cursor values it did not author monotonically per
  session or per connection — the vendor service skipped a value once.
