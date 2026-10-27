import type { RouteHandler } from "../types.js";
import { sendJson, sendError } from "../response.js";

/**
 * GET /api/v1/observations
 * Retrieves historical TTL observations with optional filters and bounded pagination.
 */
export const observationsHandler: RouteHandler = (_req, res, url, ctx) => {
  const params = url.searchParams;

  // Validate watchlistId
  let watchlistId: number | undefined;
  if (params.has("watchlistId")) {
    const rawId = Number(params.get("watchlistId"));
    if (!Number.isInteger(rawId) || rawId < 1) {
      return sendError(
        res,
        400,
        "INVALID_PARAMETER",
        "watchlistId must be a positive integer",
        ctx.corsOrigin,
      );
    }
    watchlistId = rawId;
  }

  // Validate network
  const network = params.get("network") || undefined;
  if (network && network !== "testnet" && network !== "mainnet") {
    return sendError(
      res,
      400,
      "INVALID_PARAMETER",
      "Network must be 'testnet' or 'mainnet'",
      ctx.corsOrigin,
    );
  }

  // Validate status
  const status = params.get("status") || undefined;
  if (status && !["live", "ttlReached", "unknown"].includes(status)) {
    return sendError(
      res,
      400,
      "INVALID_PARAMETER",
      "status must be one of: 'live', 'ttlReached', 'unknown'",
      ctx.corsOrigin,
    );
  }

  // Validate pagination
  let limit = 50;
  if (params.has("limit")) {
    const rawLimit = Number(params.get("limit"));
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      return sendError(
        res,
        400,
        "INVALID_PARAMETER",
        "limit must be an integer between 1 and 100",
        ctx.corsOrigin,
      );
    }
    limit = rawLimit;
  }

  let offset = 0;
  if (params.has("offset")) {
    const rawOffset = Number(params.get("offset"));
    if (!Number.isInteger(rawOffset) || rawOffset < 0) {
      return sendError(
        res,
        400,
        "INVALID_PARAMETER",
        "offset must be a non-negative integer",
        ctx.corsOrigin,
      );
    }
    offset = rawOffset;
  }

  try {
    const observations = ctx.db.listObservations({
      ...(watchlistId !== undefined ? { watchlistId } : {}),
      network: network ?? ctx.network,
      ...(status !== undefined ? { status } : {}),
      limit,
      offset,
    });

    sendJson(
      res,
      200,
      {
        success: true,
        data: observations,
        pagination: {
          limit,
          offset,
          returned: observations.length,
        },
        timestamp: new Date().toISOString(),
      },
      ctx.corsOrigin,
    );
  } catch (err) {
    ctx.logger.error({ err }, "Database error in /api/v1/observations");
    sendError(res, 500, "INTERNAL_ERROR", "Failed to retrieve observations", ctx.corsOrigin);
  }
};
