import { promises as fs } from "node:fs";
import path from "node:path";
import type { MloConfig, TaskNode } from "./types.js";
import type { MloDocument } from "./xml.js";
import { parseMloXml, buildMloXml } from "./xml.js";
import { buildTaskTree } from "./task-tree.js";
import {
  exportXmlUnlocked,
  convertXmlToMlUnlocked,
  isMloRunning,
  closeMloGui,
  launchMloGui,
  withMloFileLock,
  MloError,
} from "./mlo-cli.js";
import { log } from "./log.js";

export interface WriteResult {
  backupPath: string;
  /** true when the MLO GUI was closed for the write and relaunched afterwards */
  guiRestarted: boolean;
}

/**
 * Round-trip write (Phase 3, gated on the E1 lossless result):
 *   fresh export → mutate(doc) → build XML → -saveML to temp .ml →
 *   backup original → replace → verify via re-export → restore on failure.
 *
 * The running MLO GUI holds the tree in memory and would overwrite our
 * replacement on its next autosave, so it must not be open during the swap.
 * With autoRestartGui (default) the GUI is closed gracefully first — it saves
 * on close, exactly like clicking X — and relaunched afterwards; otherwise
 * the write is refused while MLO is open.
 */
export function replaceDataFile(
  config: MloConfig,
  mutate: (doc: MloDocument) => void,
  verify: (tasks: TaskNode[]) => boolean
): Promise<WriteResult> {
  // Hold BOTH locks (in-process chain + cross-process lock dir) across the
  // whole close → replace → verify → relaunch window: another mlo-mcp process
  // exporting mid-swap would race the .ml file and trigger MLO's
  // "file is locked by another process" dialog.
  return withMloFileLock(config, async () => {
    let guiRestarted = false;
    if (await isMloRunning()) {
      if (!config.autoRestartGui) {
        throw new MloError(
          "The MyLifeOrganized app is running — it holds the data file in memory and would " +
            "overwrite this change on its next save. Close MLO (including the tray icon) and retry, " +
            "or unset MLO_AUTO_RESTART_GUI=0 to let the server restart MLO around writes."
        );
      }
      log("closing the MLO GUI for a write (it will be relaunched)");
      await closeMloGui();
      guiRestarted = true;
    }

    try {
      return await replaceClosed(config, mutate, verify, guiRestarted);
    } finally {
      if (guiRestarted) {
        await launchMloGui(config);
        log("relaunched the MLO GUI");
      }
    }
  });
}

async function replaceClosed(
  config: MloConfig,
  mutate: (doc: MloDocument) => void,
  verify: (tasks: TaskNode[]) => boolean,
  guiRestarted: boolean
): Promise<WriteResult> {
  const doc = parseMloXml(await exportXmlUnlocked(config));
  mutate(doc);

  await fs.mkdir(config.exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tempXml = path.join(config.exportDir, `write-${stamp}.xml`);
  const tempMl = path.join(config.exportDir, `write-${stamp}.ml`);
  const backupPath = `${config.dataFile}.bak-${stamp}`;

  try {
    await fs.writeFile(tempXml, buildMloXml(doc), "utf8");
    await convertXmlToMlUnlocked(config, tempXml, tempMl);

    await fs.copyFile(config.dataFile, backupPath);
    await fs.copyFile(tempMl, config.dataFile);

    const after = buildTaskTree(parseMloXml(await exportXmlUnlocked(config)));
    if (!verify(after)) {
      await fs.copyFile(backupPath, config.dataFile);
      throw new MloError(
        `verification after write failed — the data file was restored from backup (${backupPath})`
      );
    }
    log(`data file replaced; backup at ${backupPath}`);
    return { backupPath, guiRestarted };
  } finally {
    await fs.rm(tempXml, { force: true });
    await fs.rm(tempMl, { force: true });
  }
}
