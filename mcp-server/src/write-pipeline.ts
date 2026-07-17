import { promises as fs } from "node:fs";
import path from "node:path";
import type { MloConfig, TaskNode } from "./types.js";
import type { MloDocument } from "./xml.js";
import { parseMloXml, buildMloXml } from "./xml.js";
import { buildTaskTree } from "./task-tree.js";
import { exportXml, convertXmlToMl, isMloRunning, MloError } from "./mlo-cli.js";
import { log } from "./log.js";

export interface WriteResult {
  backupPath: string;
}

/**
 * Round-trip write (Phase 3, gated on the E1 lossless result):
 *   fresh export → mutate(doc) → build XML → -saveML to temp .ml →
 *   backup original → replace → verify via re-export → restore on failure.
 *
 * Refuses when the MLO GUI is running: the GUI holds the tree in memory and
 * would overwrite our replacement on its next autosave.
 */
export async function replaceDataFile(
  config: MloConfig,
  mutate: (doc: MloDocument) => void,
  verify: (tasks: TaskNode[]) => boolean
): Promise<WriteResult> {
  if (await isMloRunning()) {
    throw new MloError(
      "The MyLifeOrganized app is running — it holds the data file in memory and would " +
        "overwrite this change on its next save. Close MLO (including the tray icon) and retry."
    );
  }

  const doc = parseMloXml(await exportXml(config));
  mutate(doc);

  await fs.mkdir(config.exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tempXml = path.join(config.exportDir, `write-${stamp}.xml`);
  const tempMl = path.join(config.exportDir, `write-${stamp}.ml`);
  const backupPath = `${config.dataFile}.bak-${stamp}`;

  try {
    await fs.writeFile(tempXml, buildMloXml(doc), "utf8");
    await convertXmlToMl(config, tempXml, tempMl);

    await fs.copyFile(config.dataFile, backupPath);
    await fs.copyFile(tempMl, config.dataFile);

    const after = buildTaskTree(parseMloXml(await exportXml(config)));
    if (!verify(after)) {
      await fs.copyFile(backupPath, config.dataFile);
      throw new MloError(
        `verification after write failed — the data file was restored from backup (${backupPath})`
      );
    }
    log(`data file replaced; backup at ${backupPath}`);
    return { backupPath };
  } finally {
    await fs.rm(tempXml, { force: true });
    await fs.rm(tempMl, { force: true });
  }
}
