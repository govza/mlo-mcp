/**
 * MLO's local modification baseline as sent in
 * `ApplyModificationsBytesEx.lastSyncTimestamp`.
 *
 * This is NOT a remote cloud version and must never be compared against a
 * CloudCursor: the two counters advance for different events at different
 * rates, and a captured valid vendor session used local stamp 24838 against
 * remote version 15515 (docs/mlo/cloud-sync.md, "Local and remote stamps are
 * separate namespaces"). The value is opaque: accepted, recorded for
 * diagnostics, and otherwise unused.
 */
export type LocalStamp = bigint & { readonly __brand: "LocalStamp" };

const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;

export function parseLocalStamp(value: string): LocalStamp {
  if (!/^-?[0-9]+$/.test(value)) throw new Error(`invalid local sync stamp: "${value}"`);
  const parsed = BigInt(value);
  if (parsed < INT64_MIN || parsed > INT64_MAX) {
    throw new Error(`local sync stamp exceeds signed 64-bit range: "${value}"`);
  }
  return parsed as LocalStamp;
}

export function localStampToString(value: LocalStamp): string {
  return value.toString(10);
}
