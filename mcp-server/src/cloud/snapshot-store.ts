import { promises as fs } from "node:fs";
import path from "node:path";
import { emitSectionedCsv, parseSectionedCsv, type SectionedCsv } from "./csv.js";
import { cursorToDecimalString, parseCursor, type CloudCursor } from "./cursor.js";

/**
 * Persisted materialized snapshot for one delta log.
 *
 * The snapshot document is stored VERBATIM as sectioned CSV — including its
 * historical tombstone rows, unknown sections, unknown columns, and opaque
 * cells — because unknown-preservation is a protocol requirement and the
 * emitted CSV is the representation whose round-trip is already tested.
 * Projections merge the snapshot document first, then only the log entries
 * newer than the snapshot's version, replacing the previous re-merge of the
 * entire log on every read.
 *
 * Layout (inside the owning log's state dir, so log + baseline travel
 * together): `snapshot/snapshot-<seq>.csv` plus a `snapshot/snapshot.json`
 * pointer written last via temp-then-rename — the pointer swap is the commit
 * point, making materialization transactional on NTFS.
 */
interface SnapshotPointer {
  file: string;
  version: string;
  seq: number;
  materializedAt: string;
}

export interface LoadedSnapshot {
  document: SectionedCsv;
  version: CloudCursor;
}

export class SnapshotStore {
  constructor(readonly dir: string) {}

  private pointerPath(): string {
    return path.join(this.dir, "snapshot.json");
  }

  private async pointer(): Promise<SnapshotPointer | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.pointerPath(), "utf8")) as SnapshotPointer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }

  async load(): Promise<LoadedSnapshot | undefined> {
    const pointer = await this.pointer();
    if (!pointer) return undefined;
    const text = await fs.readFile(path.join(this.dir, pointer.file), "utf8");
    return { document: parseSectionedCsv(text), version: parseCursor(pointer.version) };
  }

  async version(): Promise<CloudCursor | undefined> {
    const pointer = await this.pointer();
    return pointer ? parseCursor(pointer.version) : undefined;
  }

  /** Transactionally store `document` as the baseline covering `version`. */
  async materialize(document: SectionedCsv, version: CloudCursor): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const previous = await this.pointer();
    const seq = (previous?.seq ?? 0) + 1;
    const file = `snapshot-${seq}.csv`;
    const target = path.join(this.dir, file);
    const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const handle = await fs.open(temporary, "w");
    try {
      await handle.writeFile(emitSectionedCsv(document));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    const pointer: SnapshotPointer = {
      file,
      version: cursorToDecimalString(version),
      seq,
      materializedAt: new Date().toISOString(),
    };
    const pointerTemporary = `${this.pointerPath()}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(pointerTemporary, `${JSON.stringify(pointer, null, 2)}\n`);
    await fs.rename(pointerTemporary, this.pointerPath());
    if (previous && previous.file !== file) {
      await fs.rm(path.join(this.dir, previous.file), { force: true });
    }
  }
}
