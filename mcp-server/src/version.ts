import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Identity an MCP client receives at connection time, derived from the package
 * that ships rather than restated as a literal here. The two copies drifted
 * once — the server reported 0.2.0 while all three manifests said 0.3.0 — and
 * the stale one was the only version a user could actually observe.
 *
 * `../package.json` resolves in every layout this module runs from: `src/`
 * under tsx, `dist/` after tsc, and `dist-bundle/` after esbuild are all
 * direct children of `mcp-server/`. The bundle is therefore single-file but
 * not standalone — it needs that sibling manifest, which is why the root
 * package's `files` list ships it.
 *
 * Deliberately no fallback literal: a wrong version reported confidently is
 * the defect this module exists to remove, so an unreadable manifest fails
 * loudly at startup instead.
 */
function shippedVersion(): string {
  const manifest = fileURLToPath(new URL("../package.json", import.meta.url));
  try {
    return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  } catch (error) {
    throw new Error(
      `cannot read the server version from ${manifest}: ${error instanceof Error ? error.message : String(error)} — ` +
        "the single-file bundle still needs its sibling package.json"
    );
  }
}

export const SERVER_INFO = { name: "mlo-mcp", version: shippedVersion() };
