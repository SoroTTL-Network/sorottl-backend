import type { RouteHandler } from "../types.js";
import { sendJson, sendError } from "../response.js";

/**
 * GET /api/v1/watchlist
 * Retrieves monitored contracts with optional filters and bounded pagination.
 * Augments each record with its latest observation for immediate UI inspection.
 */
export const watchlistHandler: RouteHandler = (_req, res, url, ctx) => {
  const params = url.searchParams;

  // Validate network parameter
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

  // Validate enabledOnly parameter
  let enabledOnly: boolean | undefined = undefined;
  if (params.has("enabledOnly")) {
    const val = params.get("enabledOnly");
    if (val === "true" || val === "1") {
      enabledOnly = true;
    } else if (val === "false" || val === "0") {
      enabledOnly = false;
    } else {
      return sendError(
        res,
        400,
        "INVALID_PARAMETER",
        "enabledOnly must be a boolean ('true' or 'false')",
        ctx.corsOrigin,
      );
    }
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
    const items = ctx.db.listWatchlist({
      network: network ?? ctx.network,
      ...(enabledOnly !== undefined ? { enabledOnly } : {}),
      limit,
      offset,
    });

    // Augment with latest observation
    const augmented = items.map((item) => {
      const latestObs = ctx.db.getLatestObservation(item.id);
      return {
        ...item,
        latestObservation: latestObs
          ? {
              status: latestObs.status,
              currentLedger: latestObs.currentLedger,
              liveUntilLedgerSeq: latestObs.liveUntilLedgerSeq,
              remainingLedgers: latestObs.remainingLedgers,
              durability: latestObs.durability,
              confidence: latestObs.confidence,
              observedAt: latestObs.observedAt,
            }
          : null,
      };
    });

    sendJson(
      res,
      200,
      {
        success: true,
        data: augmented,
        pagination: {
          limit,
          offset,
          returned: augmented.length,
        },
        timestamp: new Date().toISOString(),
      },
      ctx.corsOrigin,
    );
  } catch (err) {
    ctx.logger.error({ err }, "Database error in /api/v1/watchlist");
    sendError(res, 500, "INTERNAL_ERROR", "Failed to retrieve watchlist", ctx.corsOrigin);
  }
};
