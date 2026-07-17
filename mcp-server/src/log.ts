/** stderr-only logging — stdout carries the JSON-RPC stream. */
export function log(message: string): void {
  process.stderr.write(`[mlo-mcp] ${message}\n`);
}
