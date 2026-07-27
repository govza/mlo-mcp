import type { MloConfig } from "./types.js";
import type { CloudGateway } from "./cloud/gateway.js";
import type { ResidentEndpoint } from "./cloud/endpoint.js";
import type { MloRepository } from "./repo/mlo-repository.js";
import { OutlineService } from "./services/outline.js";
import { NextActionsService } from "./services/next-actions.js";
import { ReviewService } from "./services/review.js";
import { AdminService } from "./services/admin.js";
import type { ToolContext } from "./tools/contract.js";
import { log } from "./log.js";

/**
 * The one place repositories are wired into services (spec section 1). Shared
 * by every composition root — the MCP session entry and scripts/run-tool.ts —
 * so adding a service stays a single edit.
 */
export function createToolContext(
  config: MloConfig,
  repo: MloRepository,
  cloud: CloudGateway,
  endpoint: ResidentEndpoint
): ToolContext {
  return {
    outline: new OutlineService(repo),
    nextActions: new NextActionsService(),
    review: new ReviewService(),
    admin: new AdminService(config, repo, cloud, endpoint),
    config,
    log,
  };
}
