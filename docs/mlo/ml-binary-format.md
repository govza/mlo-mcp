# The .ml data-file binary format

What we decoded of MLO's native profile format — enough to recover per-task GUIDs that the XML export omits. Parser implementation: `mcp-server/src/guids.ts`.

## Container layout

```
0x00    "MyLifeDataFile2\0"            (16-byte magic)
0x10    metadata (file GUID, version)
0x58    PK\x03\x04 ZIP local header, entry name "ZIPDATA"
        └── raw-deflate payload: the actual task database
...     second ZIP (password-protected) — archived/deleted tasks, untouched
```

Decompress: locate the first `PK\x03\x04`, read the local-file-header fields (compressed size at +18, name/extra lengths at +26/+28), `inflateRaw` the payload.

## Inside ZIPDATA

- Header: uint32 formatVersion, uint32 contextCount, flags.
- **Contexts[]**: uint32-length-prefixed UTF-8 name + ~2100 bytes fixed data (schedule bitmap etc.).
- **Tasks**: the tree is serialized **recursively**:
  - a node's caption (uint32-LE length prefix + UTF-8) is written on entry → captions appear in **pre-order**;
  - the node's footer is written after all of its children → footers appear in **post-order**;
  - the footer contains the task's 16-byte GUID preceded by the marker bytes `64 00 00 00 01 00 00 00 00 00 00 00`.
- Other known record content: `0x64` ('d') marker after the caption, importance/effort as uint32s (0–200 scale), notes as length-prefixed strings, Delphi TDateTime doubles (days since 1899-12-30), an incrementing uint32 internal id.

## Caption→GUID alignment algorithm

Given a fresh XML export of the *same file state* (for the tree shape) and the inflated binary:

1. Walk the XML tree pre-order; match each caption sequentially in the binary with a moving cursor, requiring the uint32 length prefix to equal the caption's byte length (this disambiguates duplicate and substring captions).
2. Compute each node's subtree end bound = the caption offset of the next pre-order node after its subtree (or EOF).
3. Find all GUID-footer offsets (the 12-byte marker).
4. Walk the tree post-order, assigning the next unconsumed GUID to each node **iff** it lies inside `(captionOffset, subtreeEndBound)` — nodes whose footer doesn't match the pattern are simply skipped.

Reliability on the test profile: ~97% of tasks mapped. Known gaps:

- **Recurring tasks** use a different footer layout — no GUID recovered (callers must tolerate `Guid === undefined`).
- The file's **last** GUID belongs to the invisible root — it is **not a valid `-task` target** (targeting it pops a modal Warning and hangs the CLI); the algorithm never assigns it.
- GUIDs are formatted Windows mixed-endian: first three groups little-endian, rest big-endian.

Note: since dependencies were implemented, `<IDD>` values from the XML export are the authoritative GUID source where present; binary extraction fills in the rest.
