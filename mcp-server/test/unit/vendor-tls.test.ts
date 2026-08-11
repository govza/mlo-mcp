import { afterEach, describe, expect, it } from "vitest";
import { secureVendorTarget } from "../../src/cloud/upstream.js";
import { VENDOR_SYNC_HOST } from "../../src/cloud/sync-observer.js";

/**
 * MLO speaks plaintext to the endpoint (a TLS tunnel would be opaque to
 * capture), but that is loopback. The leg the endpoint opens to the vendor
 * crosses the internet carrying credentials, so it is upgraded to TLS — and
 * only for the real vendor host, or every loopback fake in these tests would
 * be dialled over https.
 */
describe("secureVendorTarget", () => {
  afterEach(() => { delete process.env.MLO_VENDOR_PLAINTEXT; });

  it("upgrades the vendor host to https, keeping path and query", () => {
    const upgraded = secureVendorTarget(new URL(`http://${VENDOR_SYNC_HOST}/mlo/MLOInetSync.asmx?WSDL`));
    expect(upgraded.href).toBe(`https://${VENDOR_SYNC_HOST}/mlo/MLOInetSync.asmx?WSDL`);
    expect(upgraded.host).toBe(VENDOR_SYNC_HOST);
  });

  it("upgrades an explicit port 80 and leaves an already-secure target alone", () => {
    expect(secureVendorTarget(new URL(`http://${VENDOR_SYNC_HOST}:80/mlo/x.asmx`)).protocol).toBe("https:");
    const already = new URL(`https://${VENDOR_SYNC_HOST}/mlo/x.asmx`);
    expect(secureVendorTarget(already).href).toBe(already.href);
  });

  it("leaves other hosts, private endpoints and odd ports untouched", () => {
    for (const raw of [
      "http://127.0.0.1:8282/mlo/MLOInetSync.asmx",
      "http://sync.example.test/MLOInetSync.asmx",
      `http://${VENDOR_SYNC_HOST}:8080/mlo/x.asmx`,
    ]) {
      expect(secureVendorTarget(new URL(raw)).href).toBe(new URL(raw).href);
    }
  });

  it("MLO_VENDOR_PLAINTEXT=1 turns the upgrade off", () => {
    process.env.MLO_VENDOR_PLAINTEXT = "1";
    const raw = `http://${VENDOR_SYNC_HOST}/mlo/x.asmx`;
    expect(secureVendorTarget(new URL(raw)).href).toBe(raw);
  });
});
