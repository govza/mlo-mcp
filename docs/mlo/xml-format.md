# MLO XML format

Produced by `mlo.exe <file.ml> -saveXML=...` and consumed by `mlo.exe <file.xml> -saveML=...`. The round-trip is lossless for task data. Document root:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MyLifeOrganized-xml ver="1.2">
  <TaskTree>
    <TaskNode Caption="">           <!-- invisible root; its children are the top-level tasks -->
      <TaskNode Caption="...">...</TaskNode>
    </TaskNode>
  </TaskTree>
  <PConfig>...</PConfig>            <!-- app state: preserve untouched on round-trips -->
  <PlacesList>...</PlacesList>      <!-- context definitions (TaskPlace, open hours, includes) -->
  <Flags>...</Flags>                <!-- flag definitions with icon bitmaps -->
  <!-- ToDoView / Column / Rule view-state sections follow -->
</MyLifeOrganized-xml>
```

Hierarchy is expressed purely by `<TaskNode>` nesting. Tasks have **no ids in XML** except `<IDD>` (below).

## TaskNode element reference (Delphi field → XML element)

| Delphi field | XML | Type / notes |
|---|---|---|
| FCaption | `Caption` **attribute** | string; entities (`&quot;` etc.) for specials |
| — | `<IDD>` | task GUID `{8-4-4-4-12}`; exported **only when another task references this one** |
| FNote | `<Note>` | multiline; MLO appends a trailing `\n` on import |
| — | `<Dependency>` | see Dependencies below |
| FImportance | `<Importance>` | **0–200**, 100 = normal and omitted; GUI/parser 1–5 = 0/50/100/150/200 |
| FEffort | `<Effort>` | same 0–200 convention |
| FCompletionDateTime | `<CompletionDateTime>` | ISO `2026-06-25T15:00:00`, no timezone; **presence = completed** |
| FDueDateTime | `<DueDateTime>` | ISO; see the "date quartet" rule below |
| FStartDateTime | `<StartDateTime>` | ISO |
| — | `<LeadTime>` | days (int) |
| FScheduleType | `<ScheduleType>` | int; 1 observed for plainly scheduled tasks |
| — | `<IsProject>` | `-1` = true (Delphi boolean; applies to ALL booleans — never emit `true`/`1`) |
| — | `<ProjectStatus>` | int; 1 = active, 3 = completed (observed) |
| FStarred | `<Starred>` | `-1` / absent |
| FFlag | `<Flag>` | flag caption, e.g. `Green Flag` |
| FPlaces | `<Places><Place>@Office</Place>...</Places>` | contexts |
| FEstimate | `<EstimateMin>` / `<EstimateMax>` | fractional **days** |
| FTheGoal | `<TheGoal>` | 1 = weekly, 2 = monthly, 3 = yearly |
| FHideInToDo | `<HideInToDo>` | hide task AND whole branch from to-do views |
| — | `<HideInToDoThisTask>` | hide only this task = **MLO's "folder"** (the `-f` parser switch emits exactly this) |
| FCompleteSubTasksInOrder | `<CompleteSubTasksInOrder>` | `-1`; sequential ("tree") dependency between siblings |
| FRecurrencePattern | `<Recurrence .../>` | attributes; `PatternStartDate` is a Delphi TDateTime int (days since 1899-12-30) |

## Import rules learned the hard way

- **The date quartet**: a bare `<DueDateTime>` is silently **dropped** by `-saveML` import. Emit the full set MLO itself writes: `DueDateTime` + `StartDateTime` + `LeadTime>0<` + `ScheduleType>1<`.
- **Booleans**: `-1` when true, element absent when false.
- **Unknown/extra sections** (`PConfig`, `PlacesList`, views): pass through unmodified; MLO tolerates element-order differences within a TaskNode, but keep scalar elements before nested `<TaskNode>` children (matching MLO's own layout).

## Dependencies

A task that waits for others carries **one** `<Dependency>` block with one `<UID>` per target:

```xml
<TaskNode Caption="Install new cables">
  <Dependency>
    <UID>{5E725893-0CBE-499D-A556-2922220A106E}</UID>
    <UID>{4DE25A05-9B97-48BB-897F-CA4E515A1A08}</UID>
  </Dependency>
</TaskNode>
```

Each referenced task carries its GUID as `<IDD>{...}</IDD>` (first child element). Rules, all verified:

- Repeated `<Dependency>` blocks are **silently dropped** — always one block, many `<UID>`s.
- On import MLO **regenerates every GUID** but remaps all Dependency/IDD pairs consistently — links survive round-trips; the GUID *values* do not.
- Injected `<IDD>`s on previously-unreferenced tasks are honored, so dependencies can be created purely in XML: assign the target any fresh GUID as `<IDD>`, reference it from the dependent's `<Dependency>`.
