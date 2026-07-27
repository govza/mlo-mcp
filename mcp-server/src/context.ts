import type { MloConfig } from "./types.js";
import type { CloudGateway } from "./cloud/gateway.js";
import type { ResidentEndpoint } from "./cloud/endpoint.js";
import type { MloRepository } from "./repo/mlo-repository.js";
import { OutlineService } from "./services/outline.js";
import { IdentityService } from "./services/identity.js";
import { EMPTY_ROW_STORE_VIEW, type RowStore } from "./cloud/row-store.js";
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
  endpoint: ResidentEndpoint,
  // The bound partition's row store: identity's confidence cross-check and
  // OutlineService's authoring source. Absent when the profile is unbound at
  // session start — every resolution then honestly reads as unconfirmed, and
  // every write refuses `partition-not-ready`.
  rows?: RowStore
): ToolContext {
  const identity = new IdentityService(rows?.view() ?? EMPTY_ROW_STORE_VIEW);
  return {
    outline: new OutlineService(repo, identity, rows, { inboxCaption: config.inboxCaption }),
    nextActions: new NextActionsService(),
    review: new ReviewService(),
    admin: new AdminService(config, repo, cloud, endpoint),
    config,
    log,
  };
}
