export type CloudCursor = bigint & { readonly __brand: "CloudCursor" };

export const ZERO_CURSOR = 0n as CloudCursor;

export function cursorToDecimalString(value: CloudCursor): string {
  return value.toString(10);
}

export function parseCursor(value: string): CloudCursor {
  if (!/^[0-9]+$/.test(value)) throw new Error(`invalid cloud cursor: "${value}"`);
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) throw new Error(`cloud cursor exceeds signed 64-bit range: "${value}"`);
  return parsed as CloudCursor;
}

