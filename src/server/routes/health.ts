import type { RouteHandler } from "../types.js";
import { sendJson, sendError } from "../response.js";

/**
 * GET /health
 * Aggregated health status reporting liveness, readiness, RPC connectivity, and keeper status.
 *
 * Status policy:
 * - 200 OK: Process is live and database readiness is verified.
 * - 503 Service Unavailable: Database is disconnected or corrupted (service cannot perform essential local functions).
 * Note: RPC connectivity issues are reported in the payload (`rpc: "unreachable"` or `"degraded"`),
 * but RPC degradation alone does NOT fail the HTTP health endpoint with 503 as long as the local database is healthy.
 */
export const healthHandler: RouteHandler = async (_req, res, _url, ctx) => {
  let dbStatus = "connected";
  let isDbReady = false;

  try {
    // Quick SQLite check
    ctx.db["db"].prepare("PRAGMA quick_check(1);").get();
    isDbReady = true;
  } catch (err) {
    dbStatus = "error";
    ctx.logger.error({ err }, "Database readiness check failed in /health");
  }

  // Check RPC with bounded timeout (max 3000ms), coalesced per context instance
  let rpcStatus = "unknown";
  let currentLedger: number | null = null;

  if (ctx.rpcClient) {
    const now = Date.now();
    const lastCheck = ctx.lastRpcCheckTime ?? 0;

    if (now - lastCheck < 2000 && ctx.cachedRpcResult) {
      // Reuse cached result within 2 seconds for this context to avoid provider flood
      rpcStatus = ctx.cachedRpcResult.rpcStatus;
      currentLedger = ctx.cachedRpcResult.currentLedger;
    } else {
      if (!ctx.inFlightRpcCheck) {
        ctx.inFlightRpcCheck = (async () => {
          try {
            const rpcPromise = ctx.rpcClient!.getLatestLedger();
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("RPC health check timed out")), 3000),
            );
            const ledger = await Promise.race([rpcPromise, timeoutPromise]);
            return { rpcStatus: "reachable", currentLedger: ledger.sequence };
          } catch {
            return { rpcStatus: "unreachable", currentLedger: null };
          } finally {
            ctx.lastRpcCheckTime = Date.now();
            ctx.inFlightRpcCheck = null;
          }
        })();
      }
      const outcome = await ctx.inFlightRpcCheck;
      ctx.cachedRpcResult = outcome;
      rpcStatus = outcome.rpcStatus;
      currentLedger = outcome.currentLedger;
    }
  }

  const isKeeperRunning = ctx.isKeeperRunning ? ctx.isKeeperRunning() : false;
  const uptimeSeconds = Math.floor((Date.now() - ctx.startedAt) / 1000);

  const statusCode = isDbReady ? 200 : 503;

  sendJson(
    res,
    statusCode,
    {
      success: isDbReady,
      data: {
        status: isDbReady ? "healthy" : "unhealthy",
        uptimeSeconds,
        network: ctx.network,
        database: dbStatus,
        rpc: rpcStatus,
        currentLedger,
        keeperRunning: isKeeperRunning,
      },
      timestamp: new Date().toISOString(),
    },
    ctx.corsOrigin,
  );
};

/**
 * GET /health/live
 * Process liveness check. Always returns 200 as long as the HTTP event loop is alive.
 */
export const livenessHandler: RouteHandler = (_req, res, _url, ctx) => {
  sendJson(
    res,
    200,
    {
      success: true,
      data: {
        status: "alive",
        uptimeSeconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
      },
      timestamp: new Date().toISOString(),
    },
    ctx.corsOrigin,
  );
};

/**
 * GET /health/ready
 * Readiness check. Returns 200 if the SQLite database is reachable and ready to serve queries,
 * or 503 if the database is inaccessible.
 */
export const readinessHandler: RouteHandler = (_req, res, _url, ctx) => {
  try {
    ctx.db["db"].prepare("PRAGMA user_version;").get();
    sendJson(
      res,
      200,
      {
        success: true,
        data: {
          status: "ready",
          database: "connected",
        },
        timestamp: new Date().toISOString(),
      },
      ctx.corsOrigin,
    );
  } catch (err) {
    ctx.logger.error({ err }, "Readiness probe failed on database user_version");
    sendError(res, 503, "NOT_READY", "Database connection is not ready", ctx.corsOrigin);
  }
};
