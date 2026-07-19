# MLO Cloud synchronization delta format

This document records the data-plane behavior observed when MLO for Windows synchronized a disposable test profile9. Its purpose is to explain how MLO projects native `.ml` changes into a lightweight portable delta.

## Main conclusion

MLO does not send its complete native `.ml` profile for each Cloud change. It creates a small logical delta:

```text
local .ml database
    -> select changed records using logical modification stamps
    -> sectioned UTF-8 data.csv
    -> standard ZIP/Deflate archive
    -> MLO-managed Cloud synchronization
```

Cloud storage behind the vendor service is not visible to the client data model.

This is distinct from removable-drive and LAN data-file synchronization. Those profiles exchange a native `.ml` file.

## Logical cursor model

Cloud synchronization uses signed 64-bit logical versions rather than wall-clock dates. The observed request/response model has two directions:

```text
pull: last accepted server version -> returned server high-water version
push: server baseline used for the local delta -> newly accepted server version
```

Exact vendor field and operation names are intentionally omitted from the implementation contract. Their semantics are what matter:

- pull requests select changes strictly newer than the last accepted server cursor;
- pull responses identify the high-water cursor represented by their returned delta;
- uploads declare the server cursor against which they were created;
- successful uploads return the next accepted server cursor;
- a synchronization session is finalized after pull/push processing;
- the server chooses Cloud cursor values; they are not dates or client-generated timestamps.

TypeScript must use `bigint` end to end:

```ts
type CloudCursor = bigint & { readonly __brand: "CloudCursor" };

function cursorToDecimalString(value: CloudCursor): string {
  return value.toString(10);
}
```

Never derive a Cloud cursor from `Date.now()`, Delphi `TDateTime`, a filesystem timestamp, or a local `.ml` modification stamp. Although local stamps and Cloud cursors are both monotonic integers, the observations do not establish that they share one numeric namespace.

## Delta payload envelope

The observed payload is a standard ZIP archive beginning with the normal local-file signature:

```text
50 4B 03 04 ...
```

It contains one observed entry:

```text
data.csv
```

The entry uses ZIP method 8 (Deflate). `data.csv` is UTF-8 without a BOM, uses CRLF line endings, and in the captured writer begins and ends with a CRLF.

This is not ordinary one-table CSV. It is a sequence of bracketed sections. Every section has a CSV header followed by zero or more rows:

```csv
[SysVersions]
FileVersion,ProgramVersion,Edition
3,6.1.3,MLO-Windows
```

`ProgramVersion` is the literal delta field and must not automatically be interpreted as the desktop executable's marketing version.

## CSV sections

Every observed payload included the same section skeleton, even when almost all tables were empty:

| Section                           | Columns                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SysVersions`                     | `FileVersion,ProgramVersion,Edition`                                                                                          |
| `Places`                          | `UID,Caption,HideFromTodo,HideFromItemProps,Hotkey,Latitude,Longitude,Radius,NotifyWhenArrive,NotifyWhenLeave,OpenHours,Note` |
| `PlaceRelations`                  | `PlaceUID,ParentPlaceUID`                                                                                                     |
| `Places.Deleted`                  | `PlaceUID`                                                                                                                    |
| `Flags`                           | `UID,Caption,HideInSelector,Index,Shortcut,Icon`                                                                              |
| `Flags.Deleted`                   | `FlagUID`                                                                                                                     |
| `TodoItems`                       | full 82-column task record, listed below                                                                                      |
| `TodoItemPlaces`                  | `TodoItemUID,PlaceUID`                                                                                                        |
| `TodoItems.Dependency`            | `TaskUID,DependencyUID`                                                                                                       |
| `TodoItems.Deleted`               | `TodoItemUID`                                                                                                                 |
| `TodoView.ManualOrdering.Starred` | `UID,ItemIndex`                                                                                                               |

The exact observed `TodoItems` header is:

```csv
UID,ParentUID,ItemIndex,Caption,Importance,Urgency,HideInToDo,HideInToDoThisTask,ScheduleType,CompletionDateTime,DueDateTime,StartDateTime,EstimateMin,EstimateMax,NextReviewDate,LastReviewed,ReviewEvery,ReviewRecurrenceType,CompleteInOrder,Effort,IsProject,ProjectStatus,DependOper,DependPostpone,CreatedDate,LastModified,TextTag,RecType,RecStartDate,RecEndDate,RecOccurrences,RecInterval,RecInstance,RecDOWMask,RecDayOfMonth,RecMonthOfYear,RecUseCompletionDate,RecUncompleteSubtasks,RecGeneratedCount,RecUncomplIfCompl,RecHourDelta,RecDNCCCopy,RecRecurWSC,GoalFor,FlagUID,Starred,StarToggleDateTime,ccUseCustomColorCoding,ccFont,ccSize,ccBold,ccItalic,ccUnderline,ccStrikethrough,ccFontColor,ccHighlightColor,ccChildrenIheritColorCoding,ccUnderlineColor,ccSideBarColor,ccBackgroundColor1_1,ccBackgroundColor1_2,ccBackgroundColor2_1,ccBackgroundColor2_2,ccUnderlineEntireRowColor,ccUnderlineEntireRowthickness,ccUnderlineDotted,ccBackgroundGradientToCenter,ccIndentRowLineAndBackground,Reminder,NextAlert,AutoAlert,AutoAlertDelta,LimitAutoAlertCount,MaxAutoAlertCount,AutoAlertIndex,ReminderState,AlertAction,Email,AppPath,AudioFile,PPCAudioFile,Note
```

Spelling and capitalization are protocol data. In particular, `ccChildrenIheritColorCoding` and `ccUnderlineEntireRowthickness` must not be corrected in a parser.

Observed GUIDs use uppercase canonical GUID strings surrounded by braces, with the shape `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`. Dates in the test rows used timezone-free local ISO form such as `2026-07-19T06:13:28`, without an offset or milliseconds.

CSV quoting rules for commas, double quotes, CRLF captions, and multiline notes have not yet been exercised. A parser must use a real CSV implementation rather than splitting rows on commas.

## Controlled add, rename, and delete experiment

One root task was created as `Added task`, renamed to `Updated task`, and deleted through MLO. The same stable task GUID and internal item index were present in all three logical operations.

| Operation                | Server cursor before | Server cursor after | ZIP bytes | CSV bytes | Relevant rows                   |
| ------------------------ | -------------------: | ------------------: | --------: | --------: | ------------------------------- |
| Add `Added task`         |                `100` |               `101` |    `1019` |    `1914` | one full row in `TodoItems`     |
| Rename to `Updated task` |                `101` |               `102` |    `1023` |    `1916` | one full row in `TodoItems`     |
| Delete                   |                `102` |               `104` |     `960` |    `1759` | one GUID in `TodoItems.Deleted` |

### Add

The add delta contained one full task row rather than a field-level patch:

- caption `Added task`;
- a new stable `UID`;
- empty `ParentUID` for the root-level task;
- `ItemIndex` `125`;
- `CreatedDate` `2026-07-19T06:12:30`;
- `LastModified` `2026-07-19T06:12:38`.

### Rename

The rename delta again contained the complete 82-column task row:

- the same `UID` and `ItemIndex`;
- the same `CreatedDate`;
- caption changed to `Updated task`;
- `LastModified` changed to `2026-07-19T06:13:28`.

A changed object is therefore projected as a full logical record, not only the changed column.

## Controlled Starred, context, Folder, Project, and Flag experiment

A second experiment used one disposable task and one QuickSync after every
single UI change. The local endpoint captured each
`ApplyModificationsBytesEx` upload byte-for-byte in `messages/delta-*.zip`.
There is no field-specific cloud method: all these changes use the same upload
operation and sectioned delta envelope.

| UI change | `TodoItems` values | Companion rows |
|---|---|---|
| Star on | `Starred=1`; `StarToggleDateTime` and `LastModified` set to the change time | `TodoView.ManualOrdering.Starred(UID, ItemIndex)` |
| Assign `@Home` | existing `Starred=1`; `LastModified` advances | `TodoItemPlaces(TodoItemUID, @Home PlaceUID)` |
| Star off | `Starred=0`; `StarToggleDateTime` and `LastModified` advance | no starred-order row; unchanged context relation is re-emitted |
| Remove last context | full task row; `LastModified` advances | zero `TodoItemPlaces` rows for the task |
| Folder on | `HideInToDoThisTask=1` | none |
| Project on | `IsProject=1`, `ProjectStatus=0` | none |
| Assign Red Flag | `FlagUID` equals the Red Flag row's UID in `Flags` | none |
| Add dependency | `DependOper=0`, `DependPostpone=0`; `LastModified` advances | `TodoItems.Dependency(TaskUID, DependencyUID)` |
| Remove last dependency | full task row; `LastModified` advances | zero `TodoItems.Dependency` rows for the task |
| Hide branch + complete in order | `HideInToDo=1`, `CompleteInOrder=1` | none |
| Add two children | each child has the parent's task UID in `ParentUID` | observed sibling `ItemIndex` values `25`, `50` |

Cloud CSV booleans are therefore `1`/`0`, not the native XML format's Delphi
`-1`/absent representation. Places and Flags are referenced by GUID; their
captions are lookup data from the `Places` and `Flags` sections.

The context removal is especially important: relation rows for an emitted task
are a **complete replacement set**. There is no `TodoItemPlaces.Deleted`
section. A merger must discard that task's older place relations when it sees a
new `TodoItems` row, then add only the `TodoItemPlaces` rows present in the same
delta. The observed app also re-emits unchanged relations when another property
of a contextual task changes.

Dependencies use the same complete-replacement rule. `TaskUID` is the waiting
task; `DependencyUID` is the blocker. Removing the last blocker is represented
by the waiting task's full row and no dependency rows, with no deletion table.

### Delete

The delete delta contained:

- no `TodoItems` row;
- no old or new caption;
- one row under `[TodoItems.Deleted]`;
- exactly one value in that row: the uppercase braced task GUID.

No deletion wall-clock time or per-object modification stamp appears in the portable CSV tombstone. Those values still exist in the native local model, while Cloud ordering is represented by the server cursor.

The server cursor advanced from `102` to `104` for this one visible deletion row. The observations do not explain the second consumed version. It may represent another server-side logical change, but that remains an inference and must not be hard-coded.

## Safe TypeScript decoding boundary

A local, read-only fixture decoder may use these layers:

```text
captured sanitized payload fixture
  -> ZIP reader
  -> UTF-8 section splitter and CSV parser
  -> typed tables keyed by GUID
```

Implementation requirements:

- use a CSV parser that supports quoted commas, quotes, and multiline values;
- preserve unknown sections and columns;
- require a supported `FileVersion` before interpreting fields;
- preserve the exact section and column spellings;
- represent logical cursors as `bigint`;
