import { randomUUID } from "node:crypto";

/**
 * GUID minting and normalization — the one form MLO's CSV columns accept:
 * brace-wrapped, upper-case, canonically hyphenated.
 */

export function normalizeGuid(uid: string): string {
  const raw = uid.replace(/^\{/, "").replace(/\}$/, "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new Error(`invalid GUID: "${uid}"`);
  }
  return `{${raw.toUpperCase()}}`;
}

export function generateGuid(): string {
  return `{${randomUUID().toUpperCase()}}`;
}
