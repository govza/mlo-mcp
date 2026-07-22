# MLO Cloud synchronization protocol

This document describes the Cloud synchronization protocol used by
MyLifeOrganized for Windows 6.1.3 (desktop build 6.1.3.3123). It covers the
SOAP transport, synchronization state machine, ZIP/CSV data plane, record
semantics, first/full synchronization, and the implications for implementing a
compatible server.

The important conclusion is that Cloud sync is a complete logical database
protocol. It is not limited to tasks created after synchronization was enabled.
On a first or full synchronization MLO exports every task, context, flag, and
relationship with stable GUIDs and complete task records. Normal sessions then
exchange logical deltas from that baseline.

## Affiliation and interoperability

This is an independent, unofficial description written for interoperability and
personal use. The project is not affiliated with, authorized by, or endorsed by
the makers of MyLifeOrganized. "MyLifeOrganized" and "MLO" are trademarks of
their respective owner, used here only to identify the software this project
interoperates with. Everything below was derived from the author observing their
own installed client and their own account's sync traffic, with account, file,
and session identifiers redacted. Review the product's own terms before using
any of this against its hosted service, and prefer a disposable profile and your
own data.

## Status and evidence

This is a reverse-engineered specification, not vendor documentation. Claims
use the following labels:

- **Captured** — seen directly in SOAP traffic or an unmodified `data.csv`
  payload produced by MLO.
- **Logged** — stated by MLO's detailed synchronization log while the captured
  session ran.
- **Client surface** — visible in the desktop client's own sync configuration
  UI, option labels, and status or error messages.
- **Inferred** — the smallest model consistent with those observations; it
  still needs a controlled experiment.

Primary evidence, all from the author's own account and installation:

- The client's sync configuration screen: the secure-connection option, HTTP
  proxy settings, sync directions, per-property exclusions, the re-synchronize
  action, the client-side conflict prompt, and the fact that branch sync is
  unavailable for Cloud.
- Sanitized SOAP shape captures in `messages/soap-summary.jsonl` — SOAP
  operation names, CSV section and header names, and synchronization lifecycle
  states all appear in the traffic and payloads themselves.
- Byte-exact deltas the author's own client uploaded, in `messages/delta-*.zip`.
- The client's detailed local sync log, used only after redacting account,
  file, and session identifiers.
- The controlled experiments summarized near the end of this document.

Do not generalize unqualified details to newer desktop or mobile versions.
`SysVersions.FileVersion`, not the client build version, is the data-plane
compatibility boundary.

## Protocol layers

```text
MLO native profile (.ml)
  |  select objects by local logical modification stamp
  v
sectioned UTF-8 data.csv
  |  ZIP method 8, entry name data.csv
  v
base64 SOAP field
  |  Get / Apply / Release operations
  v
Cloud logical history keyed by data-file UID and remote version
```

The Cloud service never receives the native `.ml` container in the observed
sync path. Removable-drive, LAN, and FTP sync can exchange native files; those
are separate transports that reuse parts of MLO's generic sync engine.

## Identifiers and clocks

Several values that look similar have different scopes. A compatible server
must not collapse them into one counter.

| Value | Scope and owner | Wire representation | Purpose |
|---|---|---|---|
| Task/context/flag UID | Object, created by a client | Braced GUID | Stable identity and foreign keys |
| `dataFileUID` | Cloud file | GUID-shaped text | Selects the remote logical database |
| `sessionID` | One sync attempt | GUID-shaped text | Groups Get/Apply/Release calls and retries |
| Local modification stamp | One local `.ml` profile, assigned by MLO | Signed integer text when sent as `lastSyncTimestamp` | Selects local objects changed since the last local baseline |
| Remote Cloud version | One Cloud file, assigned by the server | Signed integer text in `newerThan`, `maxVersion`, and `newServerTimeStamp` | Selects and orders remote changes |
| User-facing dates | Task properties | Local ISO text or field-specific numeric values | Scheduling, review, recurrence, reminders |

### Local and remote stamps are separate namespaces

This is the most important correction to the earlier notes.

In one logged session the profile started with a local modification stamp of
`24838` and a remote Cloud version of `15515`. MLO exported local modifications
newer than `24838`, sent that value with the upload, and the server returned the
new remote version `15516`. The server therefore accepts a
`lastSyncTimestamp` that can be numerically greater than its remote version.

Consequences:

- `GetModificationsBytesEx.newerThan` is a **remote Cloud version**.
- `GetModificationsBytesEx.maxVersion` is a **remote Cloud version**.
- `ApplyModificationsBytesEx.lastSyncTimestamp` is a **local MLO modification
  baseline**, not an optimistic-concurrency server cursor.
- `ApplyModificationsBytesEx.newServerTimeStamp` is a **remote Cloud version**.
- A server must not reject an upload merely because `lastSyncTimestamp` is
  greater than its current remote high-water version.
- Neither counter is a wall-clock timestamp, Delphi `TDateTime`, filesystem
  time, or JavaScript millisecond time.

Use at least signed 64-bit integer handling. JavaScript/TypeScript code should
parse these values as `bigint` and serialize them as base-10 strings.

### Object GUIDs

Payload GUIDs were uppercase canonical GUIDs surrounded by braces:

```text
{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}
```

Comparisons should be case-insensitive. The same task UID survived rename,
move, property changes, and deletion. `ParentUID`, `FlagUID`, relation tables,
dependency tables, and starred ordering all refer to these stable UIDs.

The complete first-sync `TodoItems` table is an authoritative path-to-GUID and
GUID-to-record snapshot. Binary `.ml` GUID recovery is not part of the Cloud
protocol.

## HTTP and SOAP transport

### Endpoint and SOAP version

The desktop connects to the vendor's Cloud sync web service, reading its
location from the client's own configuration. This document writes that host as
`<vendor-sync-host>` and the ASMX service path as `<sync-endpoint>`; substitute
the values from your own client if you need them. The WSDL is served at:

```text
https://<vendor-sync-host>/<sync-endpoint>?wsdl
```

The client also offers HTTP, HTTPS, and beta variants. Its Cloud login screen
has a “Use secure connection (recommended)” option and explicit HTTP proxy
settings.

The captured synchronization calls use SOAP 1.1:

- HTTP `POST` to `/<sync-endpoint>`;
- XML namespace `http://schemas.xmlsoap.org/soap/envelope/`;
- application namespace `http://<vendor-namespace>/`;
- `SOAPAction` of
  `http://<vendor-namespace>/<OperationName>`;
- XML request and response bodies.

The client also advertises SOAP 1.2 support, but the controlled desktop captures
used SOAP 1.1. A proxy sees absolute-form HTTP request targets; direct
connections normally use origin form.

### Credentials and opaque common fields

The three sync operations include some or all of these common fields:

| Field | Captured role | Compatibility guidance |
|---|---|---|
| `loginBytes` | Account credential/identity bytes | Sensitive; do not log or persist unnecessarily |
| `passwordBytes` | Account credential bytes | Sensitive; do not log or persist unnecessarily |
| `additionalParams` | Opaque client/service parameters | Preserve or ignore only when intentionally replacing the vendor service |
| `sessionID` | Sync-session identifier | Treat as opaque and stable across retries |
| `encoding` | Opaque encoding selector | Exact values and enum meaning were not retained in sanitized captures |
| `dataFileUID` | Remote Cloud-file identity | Partition all remote state by this value |

Although the names end in `Bytes`, the sanitized evidence does not establish
the credential encoding. A compatible private endpoint can authenticate by a
different mechanism or ignore these fields, but it must never infer their
values from the field names.

### Control-plane operations outside the delta session

The capture also saw `LoginBytes` and `GetUserFileListBytes`. The client also
names SOAP operations for creating/updating users, listing/updating/
deleting Cloud files, billing, and file sharing. Those operations create and
select a `dataFileUID`; they are not needed once a profile is already bound to a
Cloud file.

This document specifies the three operations that carry task data. It does not
claim a complete account-management API.

## SOAP synchronization operations

Field order below is the order emitted by the observed desktop client. XML
parsers should match by element name rather than depend on order.

### `GetModificationsBytesEx`

Purpose: pull all remote changes strictly newer than the profile's last
accepted remote Cloud version.

Captured request fields:

```xml
<GetModificationsBytesEx xmlns="http://<vendor-namespace>/">
  <loginBytes>...</loginBytes>
  <passwordBytes>...</passwordBytes>
  <additionalParams>...</additionalParams>
  <sessionID>{...}</sessionID>
  <encoding>...</encoding>
  <dataFileUID>{...}</dataFileUID>
  <newerThan>15515</newerThan>
</GetModificationsBytesEx>
```

Captured success response fields:

```xml
<GetModificationsBytesExResponse xmlns="http://<vendor-namespace>/">
  <GetModificationsBytesExResult>true</GetModificationsBytesExResult>
  <maxVersion>15516</maxVersion>
  <data>UEsDB...</data>
</GetModificationsBytesExResponse>
```

Semantics:

- `newerThan` is the remote Cloud cursor already accepted by this profile.
- `maxVersion` is the remote version represented by the response.
- `data` is base64 of the ZIP envelope described below.
- With no newer changes, the logged client expects the returned remote version
  not to advance. Captured response shapes still included `data`; it may be an
  empty section skeleton.
- A higher `maxVersion` makes MLO process the returned payload as remote
  modifications.
- Remote versions need only be monotonic. One controlled deletion advanced the
  observed server version by two, so clients must not require contiguity.

### `ApplyModificationsBytesEx`

Purpose: upload the logical delta produced from local objects whose MLO-local
modification stamps are newer than a local baseline.

Captured request fields:

```xml
<ApplyModificationsBytesEx xmlns="http://<vendor-namespace>/">
  <loginBytes>...</loginBytes>
  <passwordBytes>...</passwordBytes>
  <additionalParams>...</additionalParams>
  <sessionID>{...}</sessionID>
  <encoding>...</encoding>
  <dataFileUID>{...}</dataFileUID>
  <lastSyncTimestamp>24838</lastSyncTimestamp>
  <data>UEsDB...</data>
</ApplyModificationsBytesEx>
```

Captured success response fields:

```xml
<ApplyModificationsBytesExResponse xmlns="http://<vendor-namespace>/">
  <ApplyModificationsBytesExResult>true</ApplyModificationsBytesExResult>
  <newServerTimeStamp>15516</newServerTimeStamp>
</ApplyModificationsBytesExResponse>
```

Semantics:

- `lastSyncTimestamp` is the local selection baseline reported in the MLO log
  as “Sending modifications ... newer than (...)”. It is not the remote cursor
  returned by the previous Get.
- `data` is a ZIP envelope containing complete changed records and tombstones.
- On success the service assigns and returns a new remote Cloud version.
- The captured server can assign a version that is not `previous + 1`.
- The exact vendor use of `lastSyncTimestamp` beyond diagnostics/session
  bookkeeping is not yet established. It must be accepted as an opaque local
  64-bit value by a replacement server.

The client uses boolean `...Result` fields and `errorMessage` names.
Whether every logical failure is returned as `Result=false`, as a SOAP Fault,
or as HTTP 500 has not been exhaustively captured.

### `ReleaseSyncSessionBytes`

Purpose: finish or abort a synchronization session and release server-side
session state.

Captured request fields:

```xml
<ReleaseSyncSessionBytes xmlns="http://<vendor-namespace>/">
  <loginBytes>...</loginBytes>
  <passwordBytes>...</passwordBytes>
  <encoding>...</encoding>
  <dataFileUID>{...}</dataFileUID>
  <sessionID>{...}</sessionID>
</ReleaseSyncSessionBytes>
```

Success response:

```xml
<ReleaseSyncSessionBytesResponse xmlns="http://<vendor-namespace>/">
  <ReleaseSyncSessionBytesResult>true</ReleaseSyncSessionBytesResult>
</ReleaseSyncSessionBytesResponse>
```

MLO attempts Release after success, cancellation, and many errors. The log also
shows a three-second retry and reuse of an unfinished session ID. A replacement
server should therefore make Release idempotent and should design Apply replay
handling deliberately; vendor replay/idempotency keys have not yet been
isolated.

## Synchronization state machine

### Normal bidirectional session

The desktop uses an iterative convergence loop, not a single unconditional
push followed by one pull. A representative session is:

```text
read profile's local stamp L and remote version R
create/reuse sessionID

GetModificationsBytesEx(newerThan = R)
  -> remote delta, maxVersion R1

if R1 > R:
  import remote delta into .ml
  imported/merged records receive local modification stamps

export local objects newer than the session's local baseline L
if the export is non-empty:
  ApplyModificationsBytesEx(lastSyncTimestamp = L, data = local delta)
    -> newServerTimeStamp R2

GetModificationsBytesEx(newerThan = R1)
  -> changes through R2

repeat apply/export/pull until neither side produces work
ReleaseSyncSessionBytes(sessionID)
persist the resulting local and remote baselines
```

The detailed log confirms these phases:

1. report local and remote stamps from the profile;
2. request Cloud modifications newer than the remote stamp;
3. apply the CSV locally;
4. export records newer than the previous local stamp;
5. upload them and accept a new remote stamp;
6. pull again from the previous remote maximum;
7. stop when there are no local or remote modifications;
8. release the session.

After an upload, the client performs another Get and processes the newly
assigned remote version. The evidence does not establish that the vendor
service filters out changes originating from the same client. A replacement
server must not assume “never echo a client's own upload” is part of the vendor
protocol merely because that policy is convenient for an internal log.

### Sync directions and exclusions

The desktop form exposes:

- bidirectional (recommended);
- Local to Remote;
- Remote to Local;
- do not sync reminders;
- do not sync contexts;
- do not sync flags;
- do not sync stars;
- do not sync color coding;
- do not sync goals.

These options change which phases or columns/sections MLO emits and applies.
Their exact field-clearing behavior has not been captured. A receiver should
not interpret an omitted optional section as permission to erase data outside
the sender's selected sync scope.

The generic sync engine also supports selecting a task branch, but the desktop
form explicitly states that branch sync does not work for Cloud or BlackBerry.
The client's generic CSV strings include
`TodoItems.ChangedOutsideSyncBranch` and `TodoItems.MovedToSyncBranch`; they
belong to non-Cloud branch synchronization unless a future Cloud capture proves
otherwise.

### Conflict handling

MLO knows which local objects changed after the stored local baseline and which
remote objects arrived after the stored remote version. When the same logical
object changed on both sides, the desktop has a conflict-resolution window with
Desktop, Remote, Replace, and Skip choices and property-level difference
details.

This supports the following model:

- the server orders remote deltas;
- the client tracks local per-object modification stamps in `.ml`;
- complete records give the client both versions to compare;
- resolution produces another local logical update, which is uploaded normally.

The exact automatic winner rules and server behavior for two simultaneous
sessions remain unverified.

## First synchronization and full re-synchronization

### First sync to an empty Cloud file

A captured/logged first sync behaved as follows:

1. The profile reported local and remote sync stamps of zero.
2. MLO identified the operation as “the first sync of this profile”.
3. It pulled remote modifications with `newerThan=0`.
4. The empty Cloud returned `maxVersion=0` and no logical changes.
5. MLO exported the entire local database with selection baseline zero:
   73 tasks, 9 contexts, 7 flags in that disposable profile.
6. It uploaded the full ZIP through `ApplyModificationsBytesEx` with
   `lastSyncTimestamp=0`.
7. The service returned remote version 1.
8. MLO finalized early “due to optimization”, released the session, and stored
   local and remote baselines of 1.

A separate byte capture of a complete upload contained 74 `TodoItems` rows,
18 `Places` rows, 12 `PlaceRelations`, 7 `Flags`, 44 task-place relations,
3 starred-order rows, and a `Config` section. Every task had a stable UID and a
complete 82-column record.

This is the authoritative bootstrap a compatible server needs. It proves that
old tasks are not intrinsically unaddressable through Cloud sync.

### Re-synchronize

The Advanced sync UI exposes **Re-synchronize...**. The client's confirmation
text reads:

> This will reset the sync profile and it will be completely resynchronized.

Changing important sync parameters also says the profile will be fully
re-synchronized on the next sync. The client's sync log and UI use
`ResetSyncTimeStamps`, `FullResyncPerformed`, and “Full re-synchronization
initiated”.

**Captured (controlled live run):** the button shows a confirmation dialog
only — there is **no authoritative-side selector** — and the next session
runs:

```text
Get → Apply (full snapshot) → Get → Release
```

With **Bidirectional** selected, all property exclusions unchecked, and an
empty local endpoint partition, MLO exported and uploaded its complete local
database. The captured snapshot contained 77 complete task rows, 18 contexts,
12 context relations, 7 flags, 47 task-context relations, 1 dependency,
3 starred-order rows, 10 `Config` rows, and **6 historical task tombstones**.

Two corrections this capture makes to earlier assumptions:

- A full snapshot MAY carry tombstone sections alongside the live rows.
  Bootstrap validation must allow tombstones, require them to be unique, and
  reject any overlap with live UIDs — but must not treat their presence as
  evidence of a partial upload.
- The numeric `lastSyncTimestamp` of the re-sync upload was not retained by
  the structural capture, so **no counter heuristic (such as `0`) may be used
  to recognize a re-synchronization**. A server must detect bootstrap from an
  explicitly armed session plus validated full-snapshot coverage.

### Replacing the server mid-history

If a profile already stores a nonzero remote version and is pointed at a fresh
replacement server, an ordinary QuickSync is not a bootstrap:

- MLO asks for remote changes newer than its stored remote version;
- it uploads only local objects newer than its stored local baseline;
- unchanged pre-existing tasks are not re-emitted;
- a no-op sync therefore cannot hydrate their complete rows or GUID mapping.

A replacement endpoint must use one of these sound bootstrap strategies:

1. trigger and capture MLO's explicit full re-synchronization;
2. import an authoritative full Cloud snapshot/history for that `dataFileUID`;
3. provide a separately verified client operation that resets the sync profile
   and makes MLO perform a first/full upload.

Inventing GUIDs or building partial task rows from XML is not equivalent. A
partial `TodoItems` replacement can erase recurrence, reminders, formatting,
ordering, review state, or other fields absent from XML exports.

### Switching endpoints is not a reconnect

A controlled experiment synced one profile against the vendor Cloud, then
pointed it back at a replacement endpoint. The results were destructive on
both legs:

- against the vendor, the profile imported remote history and duplicated
  whole subtrees (77 tasks grew to 131, with repeated `Personal`, `<Inbox>`,
  and project branches);
- back at the replacement endpoint, MLO presented the vendor's remote cursor
  as `newerThan` — foreign to and numerically ahead of the endpoint's own
  namespace.

Each endpoint owns a separate remote-version namespace: a profile's stored
remote cursor is meaningful only to the endpoint that assigned it.
Consequences for a compatible server:

- reject a foreign/newer cursor as an explicit **endpoint mismatch** failure;
  never silently rebase local history onto it;
- adopt a client's stored cursor only into a genuinely uninitialized state;
- moving a profile between endpoints, in either direction, requires an
  explicit full re-synchronization against an empty/new remote database — it
  cannot be accomplished by re-pointing a proxy;
- one profile must not alternate between endpoints. Keep separate `.ml`
  copies per endpoint unless endpoint-specific sync metadata can be saved and
  restored, which has not been demonstrated.

## ZIP payload envelope

**Captured:** the `data` SOAP element is standard base64 of a standard ZIP
archive.

Observed requirements:

- ZIP begins with local-file signature `50 4B 03 04`;
- exactly one observed entry, named `data.csv`;
- compression method 8 (Deflate);
- no ZIP encryption;
- `data.csv` is UTF-8 without BOM;
- MLO's writer uses CRLF between CSV records;
- captured files begin and end with a blank CRLF record.

Do not confuse this with the native `.ml` file's internal ZIP-like container.
The Cloud envelope is an ordinary portable ZIP and contains logical tables,
not native profile bytes.

## Sectioned CSV grammar

`data.csv` is a sequence of named CSV tables:

```csv

[SysVersions]
FileVersion,ProgramVersion,Edition
3,6.1.3,MLO-Windows
[TodoItems]
UID,ParentUID,...,Note
...

```

Grammar and parsing rules:

- a section marker is a one-field record matching `[SectionName]`;
- the first nonblank record after it is the header;
- following records belong to that section until the next marker;
- empty sections still have a header;
- ordinary RFC-style CSV quoting is used for commas and double quotes;
- use a real CSV parser; do not split lines or fields naively;
- preserve unknown sections and unknown columns;
- preserve exact spelling and capitalization;
- check `SysVersions.FileVersion` before assigning semantics.

Captured Notes encoded line breaks as the literal four characters `\r\n`
(backslash-r-backslash-n), rather than embedded CSV newlines. A robust parser
must nevertheless support legal quoted multiline CSV fields.

## Section catalog

### Cloud sections captured in both full and incremental payloads

| Section | Key | Columns | Semantics |
|---|---|---|---|
| `SysVersions` | singleton | `FileVersion,ProgramVersion,Edition` | Data-plane compatibility |
| `Places` | `UID` | `UID,Caption,HideFromTodo,HideFromItemProps,Hotkey,Latitude,Longitude,Radius,NotifyWhenArrive,NotifyWhenLeave,OpenHours,Note` | Complete context records |
| `PlaceRelations` | `(PlaceUID,ParentPlaceUID)` | `PlaceUID,ParentPlaceUID` | Context inclusion/hierarchy edges |
| `Places.Deleted` | `PlaceUID` | `PlaceUID` | Context tombstones |
| `Flags` | `UID` | `UID,Caption,HideInSelector,Index,Shortcut,Icon` | Complete flag definitions |
| `Flags.Deleted` | `FlagUID` | `FlagUID` | Flag tombstones |
| `TodoItems` | `UID` | 82 columns listed below | Complete changed task records |
| `TodoItemPlaces` | `(TodoItemUID,PlaceUID)` | `TodoItemUID,PlaceUID` | Task-to-context relations |
| `TodoItems.Dependency` | `(TaskUID,DependencyUID)` | `TaskUID,DependencyUID` | Waiting task to blocker relations |
| `TodoItems.Deleted` | `TodoItemUID` | `TodoItemUID` | Task tombstones |
| `TodoView.ManualOrdering.Starred` | `UID` | `UID,ItemIndex` | Ordering within Starred view |

MLO emits the same core section skeleton in ordinary small deltas, with headers
and zero rows for unchanged tables.

### `Config`

A complete upload also contained:

```csv
[Config]
Name,Value
SORT_TYPE,1
COMPUTEDSORTPRIORITY,2
DDW,3
SDW,2
WDW,5
OverdueBoost,0
ProfileDate_Desktop6,2026-07-19T23:38:33
ENCPROJ,0
EPTOPLEV,0
EPPREFIXNOT,0
```

The section is a key/value profile projection. `DDW`, `SDW`, `WDW`, and
`OverdueBoost` correspond to due/start/weekly-goal weighting options; the
remaining encoding/sort setting meanings have not all been isolated. `Config`
was not present in captured incremental deltas. Unknown keys must be preserved.

### Generic non-Cloud sections named by the client

The generic sync CSV reader/writer also names:

- `TodoItems.ChangedOutsideSyncBranch`
- `TodoItems.MovedToSyncBranch`

The associated log describes tasks moved into/out of a selected sync branch.
Because the Cloud configuration UI disables branch sync and no Cloud payload
contained these sections, they are not part of the verified Cloud skeleton.

## Record and merge semantics

### Full-record replacement

Every captured task add or update emitted all 82 `TodoItems` columns. A rename,
star toggle, context assignment, flag assignment, project toggle, move, and
dependency change each resent the complete task record.

Therefore:

- `TodoItems` is keyed by `UID`;
- the newest accepted row replaces the previous logical record;
- blank cells are explicit blank property values, not “column unchanged”;
- a receiver cannot safely construct an update from a source that lacks some
  columns;
- a forward-compatible server should retain unknown columns verbatim.

### Relations are replacement sets for changed owners

For every task emitted in `TodoItems`, the relation rows in the same delta are
the task's complete current relation sets:

- assign a context: emit task row plus its current `TodoItemPlaces` rows;
- change another property while context remains: MLO re-emits that context row;
- remove the last context: emit task row and no `TodoItemPlaces` row for it;
- add/remove dependencies: the same rule applies to
  `TodoItems.Dependency`.

There is no captured `TodoItemPlaces.Deleted` or
`TodoItems.Dependency.Deleted` section. A merger must clear the old relation
set for each changed task before adding relation rows from the same delta.

`TaskUID` is the waiting/blocked task; `DependencyUID` is the blocker.

### Deletions

Deletion uses tombstone sections:

- no complete object row is needed;
- `TodoItems.Deleted` contains only the stable task UID;
- `Places.Deleted` and `Flags.Deleted` use their respective UIDs;
- no deletion wall-clock time appears in the portable row;
- remote ordering comes from the server-assigned Cloud version.

Only a childless-task deletion has been isolated. Whether a parent tombstone
implicitly cascades to every descendant is still unverified; a conservative
producer should send explicit descendant tombstones until tested.

### Parent ordering and post-processing

Task hierarchy is encoded entirely by `ParentUID` and `ItemIndex`. The local
import log shows a waiting-for-parents queue followed by sibling sorting, so
rows need not be topologically ordered. Root tasks have blank `ParentUID`.

`ItemIndex` is an ordering key, not an array position. Values are non-contiguous
and remain stable across unrelated property changes. Newly inserted siblings
were observed at `25`, `50`, and similar spaced values; producers should not
assume a fixed increment or renumber all siblings unnecessarily.

### Starred ordering

`Starred=1` in the task row controls membership. A companion
`TodoView.ManualOrdering.Starred(UID,ItemIndex)` row controls manual ordering.
Turning Starred off emitted `Starred=0` and no ordering row. A materialized
merger should remove an old starred-order record when the task is unstarred or
deleted.

## `TodoItems` record dictionary

The exact captured header is:

```csv
UID,ParentUID,ItemIndex,Caption,Importance,Urgency,HideInToDo,HideInToDoThisTask,ScheduleType,CompletionDateTime,DueDateTime,StartDateTime,EstimateMin,EstimateMax,NextReviewDate,LastReviewed,ReviewEvery,ReviewRecurrenceType,CompleteInOrder,Effort,IsProject,ProjectStatus,DependOper,DependPostpone,CreatedDate,LastModified,TextTag,RecType,RecStartDate,RecEndDate,RecOccurrences,RecInterval,RecInstance,RecDOWMask,RecDayOfMonth,RecMonthOfYear,RecUseCompletionDate,RecUncompleteSubtasks,RecGeneratedCount,RecUncomplIfCompl,RecHourDelta,RecDNCCCopy,RecRecurWSC,GoalFor,FlagUID,Starred,StarToggleDateTime,ccUseCustomColorCoding,ccFont,ccSize,ccBold,ccItalic,ccUnderline,ccStrikethrough,ccFontColor,ccHighlightColor,ccChildrenIheritColorCoding,ccUnderlineColor,ccSideBarColor,ccBackgroundColor1_1,ccBackgroundColor1_2,ccBackgroundColor2_1,ccBackgroundColor2_2,ccUnderlineEntireRowColor,ccUnderlineEntireRowthickness,ccUnderlineDotted,ccBackgroundGradientToCenter,ccIndentRowLineAndBackground,Reminder,NextAlert,AutoAlert,AutoAlertDelta,LimitAutoAlertCount,MaxAutoAlertCount,AutoAlertIndex,ReminderState,AlertAction,Email,AppPath,AudioFile,PPCAudioFile,Note
```

The misspellings `ccChildrenIheritColorCoding` and
`ccUnderlineEntireRowthickness` are protocol data and must not be corrected.

### Identity, hierarchy, and ordinary task properties

| Column | Representation | Meaning / evidence |
|---|---|---|
| `UID` | GUID, required | Stable task key |
| `ParentUID` | GUID or blank | Blank for root; changing it moves the task |
| `ItemIndex` | integer text | Sibling/manual outline ordering key |
| `Caption` | text | Task caption; full CSV quoting applies |
| `Importance` | numeric text | Relative importance; observed 0–200 model, plain default 100 |
| `Urgency` | numeric text | Relative urgency; plain default 100 |
| `HideInToDo` | `0`/`1` | Hide the whole branch in To-Do |
| `HideInToDoThisTask` | `0`/`1` | Hide only this task; Folder uses this field |
| `ScheduleType` | integer enum | Observed `0` unscheduled, `1` ordinary dates, `2` recurring |
| `CompletionDateTime` | local ISO datetime or blank | Completion state/time |
| `DueDateTime` | local ISO datetime or blank | Due date/time for non-recurring tasks |
| `StartDateTime` | local ISO datetime or blank | Start date/time for non-recurring tasks |
| `EstimateMin` | decimal text | Minimum time estimate; exact unit conversion is not yet fixed |
| `EstimateMax` | decimal text | Maximum time estimate; exact unit conversion is not yet fixed |
| `NextReviewDate` | date value or blank | Next project/task review date; no nonblank capture yet |
| `LastReviewed` | date value or blank | Last review date; no nonblank capture yet |
| `ReviewEvery` | integer text | Review interval; plain default 1 |
| `ReviewRecurrenceType` | integer enum | Review interval unit/type; plain default 1 |
| `CompleteInOrder` | `0`/`1` | Complete subtasks in order |
| `Effort` | numeric text | Effort scale; plain default 50, observed 0–100 |
| `IsProject` | `0`/`1` | Project marker |
| `ProjectStatus` | integer enum | Observed 0 not started, 1 in progress, 2 suspended, 3 completed |
| `DependOper` | integer enum | ALL/ANY dependency operator; default 0, exact mapping unverified |
| `DependPostpone` | numeric text | Post-dependency delay; default 0 |

Cloud booleans are `1` and `0`. This differs from the native XML export, which
uses Delphi `-1` and absent/zero.

### Metadata and text tag

| Column | Representation | Meaning / evidence |
|---|---|---|
| `CreatedDate` | local ISO datetime | Logical creation time; preserved on rename/update |
| `LastModified` | local ISO datetime | User-facing last modification time; not the logical sync stamp |
| `TextTag` | text or blank | Single free-text tag |

Captured ISO values omit timezone and milliseconds, for example
`2026-07-19T06:13:28`. Do not attach UTC semantics without profile timezone
context.

### Recurrence

These cells are blank for non-recurring tasks. Recurring captures used numeric
Delphi-style values for dates/fractions rather than the ISO representation used
by ordinary start/due fields.

| Column | Representation | Meaning / current confidence |
|---|---|---|
| `RecType` | integer enum | Recurrence pattern family; observed `0` on recurring samples |
| `RecStartDate` | numeric date | Recurrence start, observed as Delphi day number |
| `RecEndDate` | numeric date | End date or sentinel; observed `0` |
| `RecOccurrences` | integer | Occurrence limit/sentinel; observed `-1` |
| `RecInterval` | integer | Pattern interval |
| `RecInstance` | integer | Instance/ordinal selector |
| `RecDOWMask` | integer bit mask | Days of week mask |
| `RecDayOfMonth` | integer | Day-of-month selector |
| `RecMonthOfYear` | integer | Month selector |
| `RecUseCompletionDate` | `0`/`1` | Recur relative to completion |
| `RecUncompleteSubtasks` | `0`/`1` | Reset/uncomplete subtasks for next occurrence |
| `RecGeneratedCount` | integer | Generated occurrence counter |
| `RecUncomplIfCompl` | `0`/`1` | Uncomplete behavior when completed |
| `RecHourDelta` | day fraction | Recurrence time offset; `0.041666667` is one hour |
| `RecDNCCCopy` | `0`/`1` or enum | Name observed; precise behavior unverified |
| `RecRecurWSC` | `0`/`1` or enum | Name observed; precise behavior unverified |

Do not synthesize these fields from only a visible due date. Rewriting a
recurring task with blank recurrence cells changes its meaning.

### Goals, flag, and star

| Column | Representation | Meaning / evidence |
|---|---|---|
| `GoalFor` | integer enum | No/weekly/monthly/yearly goal; observed 0–3, exact nonzero mapping not isolated |
| `FlagUID` | GUID or blank | Foreign key to `Flags.UID` |
| `Starred` | `0`/`1` | Star membership |
| `StarToggleDateTime` | local ISO datetime or blank | Last star-toggle time; updated on both on and off |

### Custom color coding

The prefix is `cc`. Only `ccUseCustomColorCoding=0` was nonblank in the full
fixture, so storage types for most cells remain unverified.

| Column | Intended property |
|---|---|
| `ccUseCustomColorCoding` | Enable task-specific format |
| `ccFont` | Font name |
| `ccSize` | Font size |
| `ccBold` | Bold |
| `ccItalic` | Italic |
| `ccUnderline` | Underline |
| `ccStrikethrough` | Strikeout |
| `ccFontColor` | Font color |
| `ccHighlightColor` | Highlight color |
| `ccChildrenIheritColorCoding` | Children inherit custom format |
| `ccUnderlineColor` | Underline color |
| `ccSideBarColor` | Sidebar color |
| `ccBackgroundColor1_1` | First background/gradient color component |
| `ccBackgroundColor1_2` | First background/gradient secondary component |
| `ccBackgroundColor2_1` | Second background/gradient color component |
| `ccBackgroundColor2_2` | Second background/gradient secondary component |
| `ccUnderlineEntireRowColor` | Whole-row underline color |
| `ccUnderlineEntireRowthickness` | Whole-row underline thickness |
| `ccUnderlineDotted` | Dotted underline flag |
| `ccBackgroundGradientToCenter` | Centered gradient flag |
| `ccIndentRowLineAndBackground` | Indent row line/background flag |

### Reminder and alert action

No controlled payload contained nonblank reminder fields. Names and task-model
behavior give these preliminary meanings; exact encodings require a dedicated
capture.

| Column | Intended property |
|---|---|
| `Reminder` | Reminder time/configuration |
| `NextAlert` | Next scheduled alert |
| `AutoAlert` | Automatic alert enabled/config |
| `AutoAlertDelta` | Automatic alert lead/offset |
| `LimitAutoAlertCount` | Whether repetitions are bounded |
| `MaxAutoAlertCount` | Repetition limit |
| `AutoAlertIndex` | Current repetition index |
| `ReminderState` | Reminder lifecycle state |
| `AlertAction` | Alert action enum |
| `Email` | Email action target |
| `AppPath` | Program/file action path |
| `AudioFile` | Desktop sound path |
| `PPCAudioFile` | Legacy mobile/Pocket PC sound path |
| `Note` | Full task note; captured CR/LF encoded as literal `\r\n` sequences |

## Context records

`Places` is MLO's Cloud name for contexts.

| Column | Meaning / evidence |
|---|---|
| `UID` | Stable context key |
| `Caption` | Context name |
| `HideFromTodo` | Hide context from To-Do selector/view |
| `HideFromItemProps` | Hide context from task property selector |
| `Hotkey` | Context hotkey code |
| `Latitude`, `Longitude`, `Radius` | Location trigger geometry |
| `NotifyWhenArrive`, `NotifyWhenLeave` | Geofence notification flags |
| `OpenHours` | Opaque weekly availability bitmap; captured strings are 168 hex characters |
| `Note` | Context note |

`PlaceRelations` permits multiple parents for one context, so it is a relation
graph rather than a single `ParentUID` column. Filtering semantics may treat
these edges as inclusion relationships.

## Flag records

| Column | Meaning / evidence |
|---|---|
| `UID` | Stable flag key |
| `Caption` | Display name |
| `HideInSelector` | Visibility flag |
| `Index` | Display ordering key |
| `Shortcut` | Keyboard shortcut code |
| `Icon` | Hex-encoded binary icon; captured values begin with an ICO header |

## Controlled behavior matrix

### First/full snapshot

| Event | Payload |
|---|---|
| First sync to empty Cloud file | All tasks, contexts, flags, relationships, ordering, and Config |
| Re-synchronize against an empty endpoint | The same complete upload, plus historical tombstones |
| Subsequent no-op QuickSync | No complete snapshot; only empty/no-change response |

### Task lifecycle

| UI operation | `TodoItems` / companion representation |
|---|---|
| Add | One complete 82-column row with new UID, parent, index, created/modified times |
| Rename | Complete row with same UID/index/created time; new caption and `LastModified` |
| Move | Complete row with same UID and new `ParentUID` |
| Complete | Complete row with `CompletionDateTime`; project status also changes for projects |
| Delete | UID-only `TodoItems.Deleted` tombstone; no task row |

One add/rename/delete experiment observed remote versions `100 -> 101 -> 102
-> 104`. The unexplained skipped version must not be encoded as an invariant.

### Properties and relations

| UI change | Complete row changes | Companion rows |
|---|---|---|
| Star on | `Starred=1`, toggle and modified times advance | Starred ordering row |
| Assign context | `LastModified` advances | Complete current task-place set |
| Star off | `Starred=0`, toggle and modified times advance | No starred ordering row; contexts retained/re-emitted |
| Remove last context | Full task row | Zero task-place rows for owner |
| Folder on | `HideInToDoThisTask=1` | None |
| Project on | `IsProject=1`, `ProjectStatus=0` | None |
| Assign flag | `FlagUID=<existing flag UID>` | None |
| Add dependency | dependency defaults present; modified time advances | Waiting-task/blocker row |
| Remove last dependency | Full task row | Zero dependency rows for owner |
| Hide branch | `HideInToDo=1` | None |
| Complete in order | `CompleteInOrder=1` | None |
| Add children | child `ParentUID=<parent UID>` | Sibling indices such as 25 and 50 |

There is no property-specific SOAP operation. All changes use the same Apply
operation and sectioned delta envelope.

## Compatible-server requirements

A server intended to replace MLO Cloud should satisfy these invariants:

1. Partition state by `dataFileUID`; never mix profiles.
2. Treat `sessionID` as opaque and tolerate Release/retry patterns.
3. Maintain a monotonic signed 64-bit **remote** version per Cloud file.
4. Do not treat Apply's `lastSyncTimestamp` as that remote version.
5. Retain complete latest records by stable UID plus tombstone history or an
   equivalent versioned change log.
6. Return all logical changes after `newerThan`, with a `maxVersion` that
   covers exactly the returned state.
7. Accept and emit the exact ZIP/CSV format and `FileVersion`.
8. Replace complete task records atomically; do not interpret blanks as patches.
9. Replace changed tasks' context and dependency sets atomically with their
   companion rows.
10. Preserve unknown sections, columns, Config keys, and opaque cell values.
11. Process deletions after/against updates consistently and purge dangling
    relations/order rows in materialized state.
12. Support an explicit first/full-snapshot bootstrap. Incremental history
    alone cannot reconstruct objects that predate the server.
13. Decide and test upload idempotency, same-client echo behavior, concurrent
    conflict behavior, and session recovery rather than guessing them.
14. Never log credentials or unredacted SOAP bodies by default.

## What this means for the MCP implementation

The MCP limitation described in `problems.md` is not imposed by MLO Cloud. It
comes from beginning with an incomplete local delta history and then trying to
author full-record updates from that history.

The actual protocol supplies the missing information during first/full sync:

- every existing task appears in `TodoItems`;
- every task has a stable UID;
- every task row has all 82 columns;
- parents, contexts, dependencies, flags, and ordering are explicit.

Once that full snapshot is stored, rename, move, context assignment,
completion, deletion, and all other observed operations are ordinary logical
deltas without binary GUID recovery. The correct architectural next step is to
implement a verified full-sync bootstrap/resynchronization flow and make the
Cloud state a materialized authoritative database plus versioned change log.

## Open experiments

The following questions should remain explicit until captured:

- exact SOAP/WSDL scalar types and live values for `encoding` and
  `additionalParams`;
- vendor failure bodies versus SOAP Fault/HTTP status behavior;
- whether uploads are echoed byte-for-byte to the same client on its next Get;
- replay/idempotency behavior for a repeated Apply in one `sessionID`;
- whether the vendor accepts an extra complete row merged into a client's
  outbound Apply, and whether the follow-up Get makes MLO apply it locally;
- concurrent two-client conflict cases and server transaction boundaries;
- Config update/merge behavior after initial sync;
- parent deletion cascade behavior;
- create/update/delete behavior for contexts and flags;
- nondefault dependency operators and postpone values;
- every recurrence enum and sentinel;
- review, custom-color, reminder, alert, location, and open-hours encodings;
- how each “do not sync ...” option changes complete-record semantics;
- maximum payload size, chunking, and any multi-entry envelope variants;
- why some server operations consume more than one remote version.

The echo, replay, and merged-row experiments are the gate for the MCP
endpoint's upstream write-through stage ([mcp-cloud](../mcp-cloud.md)): until
they are captured on a disposable vendor profile, MCP mutations stay disabled
for upstream-bound profiles.

Until those are resolved, preserve opaque data and prefer a rejected operation
over a lossy partial-record rewrite.
