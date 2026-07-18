// Produce the self-contained single-file server committed at dist-bundle/mlo-mcp.js.
// End users run it with bare Node (any MCP client, npx from GitHub, the Claude Code
// plugin) — pnpm/typescript/deps are contributor-only tooling. Re-run `pnpm bundle`
// and commit the result whenever src/ changes.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist-bundle/mlo-mcp.js",
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
