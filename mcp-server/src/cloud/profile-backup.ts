import { promises as fs } from "node:fs";

/**
 * Copy a profile's `.ml` beside itself before an operation that changes which
 * cloud history owns it. A rebind cannot be undone from the endpoint's state —
 * the vendor keeps the old file, but MLO's own local edits since the last sync
 * live only in this file — so the copy is taken first and the operation refuses
 * if it cannot be.
 *
 * The name is timestamped rather than rotated: an unreadable backup is worse
 * than a directory with several, and each one records a distinct decision.
 */
export async function backupDataFile(dataFile: string, at = new Date()): Promise<string> {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  const target = `${dataFile}.rebind-backup-${stamp}`;
  // COPYFILE_EXCL: a second rebind inside the same millisecond must not
  // silently overwrite the first one's evidence.
  await fs.copyFile(dataFile, target, fs.constants.COPYFILE_EXCL);
  return target;
}
