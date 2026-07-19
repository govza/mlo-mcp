import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CloudClient, type CloudPullResult } from "../src/cloud/client.js";
import { cursorToDecimalString, parseCursor, ZERO_CURSOR, type CloudCursor } from "../src/cloud/cursor.js";
import { findSection, type SectionedCsv } from "../src/cloud/csv.js";
import { buildTaskAddDelta, buildTaskDeleteDelta, generateGuid } from "../src/cloud/delta.js";
import { packEnvelope } from "../src/cloud/envelope.js";
import { nowIso } from "../src/tools/shared.js";

const args = process.argv.slice(2);
let clientName = "mlo-app";
let cursorOverride: string | undefined;
for (let index = 0; index < args.length;) {
  if (args[index] === "--client" || args[index] === "--cursor") {
    const option = args[index]!;
    const value = args[index + 1];
    if (!value) throw new Error(`${option} requires a value`);
    if (option === "--client") clientName = value;
    else cursorOverride = value;
    args.splice(index, 2);
  } else index++;
}

const stateDir = process.env.MLO_CLOUD_STATE_DIR ?? path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "messages",
);
const cursorFile = path.join(stateDir, `client-${clientName.replace(/[^a-zA-Z0-9._-]/g, "_")}-cursor.json`);
const cloud = new CloudClient({ baseUrl: process.env.MLO_CLOUD_BASE_URL, client: clientName });

async function readCursor(): Promise<CloudCursor> {
  if (cursorOverride !== undefined) return parseCursor(cursorOverride);
  try {
    const value = JSON.parse(await fs.readFile(cursorFile, "utf8")) as { cursor?: unknown };
    if (typeof value.cursor !== "string") throw new Error("cursor must be a decimal string");
    return parseCursor(value.cursor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ZERO_CURSOR;
    throw new Error(`cannot read cursor file ${cursorFile}: ${(error as Error).message}`);
  }
}

async function writeCursor(cursor: CloudCursor): Promise<void> {
  await fs.mkdir(path.dirname(cursorFile), { recursive: true });
  await fs.writeFile(cursorFile, `${JSON.stringify({ cursor: cursorToDecimalString(cursor) }, null, 2)}\n`);
}

function printSections(document: SectionedCsv): void {
  for (const section of document.sections) console.log(`${section.name}: ${section.rows.length} row(s)`);
  for (const name of ["TodoItems", "TodoItems.Deleted"]) {
    const section = findSection(document, name);
    if (section?.rows.length) console.log(JSON.stringify({ section: name, header: section.header, rows: section.rows }, null, 2));
  }
}

function printPull(result: CloudPullResult): void {
  console.log(`cursor: ${cursorToDecimalString(result.cursor)}`);
  if (result.sections) printSections(result.sections);
  else console.log("no changes");
}

async function pull(cursor: CloudCursor): Promise<CloudPullResult> {
  const result = await cloud.pull(cursor);
  printPull(result);
  await writeCursor(result.cursor);
  return result;
}

async function pushDelta(cursor: CloudCursor, commandArgs: string[]): Promise<{ cursor: CloudCursor; uid: string }> {
  let uid: string;
  let delta: SectionedCsv;
  if (commandArgs[0] === "--delete") {
    if (!commandArgs[1]) throw new Error("push --delete requires a UID");
    uid = commandArgs[1];
    delta = buildTaskDeleteDelta(uid);
  } else {
    const caption = commandArgs.join(" ");
    if (!caption) throw new Error("push requires a caption or --delete UID");
    uid = generateGuid();
    const timestamp = nowIso();
    delta = buildTaskAddDelta({ uid, caption, createdDate: timestamp, lastModified: timestamp });
  }
  const next = await cloud.push(packEnvelope(delta), cursor);
  await writeCursor(next);
  console.log(JSON.stringify({ cursor: cursorToDecimalString(next), uid }, null, 2));
  return { cursor: next, uid };
}

async function main(): Promise<void> {
  console.error(`cursor file: ${cursorFile}`);
  const [command, ...commandArgs] = args;
  if (command === "status") console.log(JSON.stringify(await cloud.status(), null, 2));
  else if (command === "pull") await pull(await readCursor());
  else if (command === "push") await pushDelta(await readCursor(), commandArgs);
  else if (command === "sync") {
    const initial = await readCursor();
    const first = await pull(initial);
    let current = first.cursor;
    let pushedUid: string | undefined;
    if (commandArgs.length) {
      const pushed = await pushDelta(current, commandArgs);
      current = pushed.cursor;
      pushedUid = pushed.uid;
    }
    await cloud.finalize();
    console.log("finalized");
    const finalPull = await pull(current);
    const ownRows = finalPull.sections ? findSection(finalPull.sections, "TodoItems")?.rows ?? [] : [];
    if (pushedUid && ownRows.some((row) => row.includes(pushedUid))) throw new Error("sync invariant failed: app received its own pushed change");
    if (finalPull.cursor < current || (pushedUid && current <= first.cursor)) throw new Error("sync invariant failed: cursor did not advance");
    console.log(`verified: own change not returned; cursor advanced to ${cursorToDecimalString(finalPull.cursor)}`);
  } else throw new Error("usage: pnpm cloud [--client NAME] [--cursor CURSOR] <status|pull|push|sync> [caption|--delete UID]");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
