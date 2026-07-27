// Produce the single-file server committed at dist-bundle/mlo-mcp.js. End users run
// it with bare Node (any MCP client, npx from GitHub, the Claude Code plugin) —
// pnpm/typescript/deps are contributor-only tooling. Dependency-free, but not
// standalone: src/version.ts reads the sibling ../package.json at startup so the
// reported version cannot drift, so the file needs that manifest next to its parent
// directory. Re-run `pnpm bundle` and commit the result whenever src/ changes.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist-bundle/mlo-mcp.js",
  // The one thing that tells the shipped server apart from a source checkout,
  // and the only reason it matters: DEFAULT_CLOUD_PORT (8181 installed, 8282
  // from source) — see src/config.ts.
  define: { __MLO_BUNDLED__: "true" },
  banner: {
    js: [
      "#!/usr/bin/env node",
      // CJS deps inside an ESM bundle may call require()
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
