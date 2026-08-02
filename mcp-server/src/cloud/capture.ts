import type { CloudGateway } from "./gateway.js";
import type { SoapOperation } from "./soap.js";
import { peekSoapResponseFields, soapFieldText as text } from "./soap.js";
import { decodeForwardBody, type ForwardResult } from "./upstream.js";
import { unpackEnvelope } from "./envelope.js";
import type { PartitionStore } from "./partition.js";
import { log } from "../log.js";

/**
 * The passive capture tap (spec sections 4-6): every forwarded sync exchange
 * of a partition this server already manages feeds the row store and the
 * capture journal. A contained tap under the non-interference invariant —
 * it runs after the vendor's response has been sent to MLO, it reads only
 * copies, and no failure in here may surface beyond the journal and a log
 * line. Callers therefore never await it.
 */

/** ZIP local-file-header magic — ordinary Get/Apply payloads are ZIP envelopes. */
function isZipPayload(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Resolve the partition an exchange belongs to — only if it already exists.
 * A UID this server was never asked to manage stays untouched (the sighting
 * next door is its only trace), so capture can never create state for a
 * foreign profile.
 */
async function existingPartition(gateway: CloudGateway, requestFields: Record<string, unknown>): Promise<PartitionStore | undefined> {
  const rawUid = text(requestFields, "dataFileUID");
  if (!rawUid) return undefined;
  try {
    return await gateway.registry.resolveExisting(rawUid);
  } catch {
    return undefined; // not GUID-shaped — routing already rejected it
  }
}

async function capture(
  gateway: CloudGateway,
  operation: SoapOperation,
  requestFields: Record<string, unknown>,
  result: ForwardResult,
): Promise<void> {
  const partition = await existingPartition(gateway, requestFields);
  if (!partition) return;

  if (operation === "GetModificationsBytesEx") {
    if (result.status !== 200) {
      await partition.journal.record("failed", `get: vendor answered HTTP ${result.status}`);
      return;
    }
    const fields = peekSoapResponseFields(decodeForwardBody(result), operation);
    const verdict = text(fields, "GetModificationsBytesExResult");
    if (verdict === undefined) {
      // unparseable body, or a parseable one without the Result field — either
      // way not a vendor verdict, and the operator must be able to tell
      await partition.journal.record("failed", "get: malformed vendor response — no parseable Result");
      return;
    }
    if (verdict !== "true") {
      await partition.journal.record("skipped", "get: vendor reported failure — nothing to capture");
      return;
    }
    const encoded = text(fields, "data")?.replace(/\s+/g, "");
    if (!encoded) {
      // an empty Get is a healthy observation of the channel: MLO synced, the
      // vendor had nothing newer
      await partition.journal.record("ok", "get: empty payload");
      return;
    }
    const bytes = Buffer.from(encoded, "base64");
    if (!isZipPayload(bytes)) {
      await partition.journal.record("skipped", "get: raw projection payload (full-history shape), not a delta envelope");
      return;
    }
    const { upserts, tombstones } = await partition.rows.ingest(unpackEnvelope(bytes), "vendor-get");
    await partition.journal.record("ok", `get: ${upserts} rows, ${tombstones} tombstones`);
    return;
  }

  if (operation === "ApplyModificationsBytesEx") {
    // The request payload is MLO's own local edits — the freshest full rows
    // that exist anywhere. Captured regardless of the vendor's verdict: a
    // rejected upload retries with the same or newer content, never older.
    const encoded = text(requestFields, "data")?.replace(/\s+/g, "");
    if (!encoded) {
      await partition.journal.record("skipped", "apply: no payload field");
      return;
    }
    const bytes = Buffer.from(encoded, "base64");
    if (!isZipPayload(bytes)) {
      await partition.journal.record("skipped", "apply: payload is not a delta envelope");
      return;
    }
    const { upserts, tombstones } = await partition.rows.ingest(unpackEnvelope(bytes), "mlo-apply");
    await partition.journal.record("ok", `apply: ${upserts} rows, ${tombstones} tombstones`);
  }
  // ReleaseSyncSessionBytes carries no payload — nothing to capture.
}

/**
 * Feed one forwarded exchange to the bound partition's row store and journal.
 * Never throws and never blocks the forward path — call it fire-and-forget
 * after the response has been written.
 */
export async function captureVendorSession(
  gateway: CloudGateway,
  operation: SoapOperation,
  requestFields: Record<string, unknown>,
  result: ForwardResult,
): Promise<void> {
  try {
    await capture(gateway, operation, requestFields, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`capture failed (forward path unaffected): ${message}`);
    try {
      const partition = await existingPartition(gateway, requestFields);
      await partition?.journal.record("failed", `${operation}: ${message}`);
    } catch {
      /* the journal itself is part of what may be failing */
    }
  }
}

/**
 * A CONNECT to the vendor sync host: sync is TLS-tunneled and the capture
 * channel is blind. No dataFileUID is visible inside a tunnel, so the
 * observation lands in every managed partition's journal — for the usual
 * single-partition root that is exact, and it is always the honest reading:
 * none of them can capture while MLO tunnels.
 */
export async function captureTlsConnectSeen(gateway: CloudGateway, host: string, port: number): Promise<void> {
  try {
    for (const summary of await gateway.registry.list()) {
      const partition = await gateway.registry.resolveExisting(summary.dataFileUID);
      await partition?.journal.record("tls-connect-seen", `${host}:${port}`);
    }
  } catch (error) {
    log(`tls-connect journal write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
