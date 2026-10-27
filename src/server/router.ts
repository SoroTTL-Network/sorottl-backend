import type { IncomingMessage, ServerResponse } from "node:http";
import * as crypto from "node:crypto";
import type { HttpServerContext, RouteHandler } from "./types.js";
import { sendError } from "./response.js";
import { healthHandler, livenessHandler, readinessHandler } from "./routes/health.js";
import { watchlistHandler } from "./routes/watchlist.js";
import { observationsHandler } from "./routes/observations.js";
import { alertsHandler } from "./routes/alerts.js";

const routes: Record<string, RouteHandler> = {
  "/health": healthHandler,
  "/health/live": livenessHandler,
  "/health/ready": readinessHandler,
  "/api/v1/watchlist": watchlistHandler,
  "/api/v1/observations": observationsHandler,
  "/api/v1/alerts": alertsHandler,
};

/**
 * Validates optional Bearer token authentication in constant time.
 * Health probes (/health, /health/live, /health/ready) are explicitly exempt.
 */
function isAuthorized(req: IncomingMessage, pathname: string, expectedToken?: string): boolean {
  if (!expectedToken) return true;
  // Exempt health endpoints
  if (pathname.startsWith("/health")) return true;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }

  const token = authHeader.slice(7).trim();
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expectedToken);

  if (tokenBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}

/**
 * Main request router.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpServerContext,
): Promise<void> {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    if (ctx.corsOrigin) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": ctx.corsOrigin,
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }
  }

  // Strictly enforce read-only HTTP methods
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendError(
      res,
      405,
      "METHOD_NOT_ALLOWED",
      `Method '${req.method}' not allowed. SoroTTL API is strictly read-only.`,
      ctx.corsOrigin,
    );
    return;
  }

  // Parse URL safely and guard against oversized URLs
  if (req.url && req.url.length > 2048) {
    sendError(
      res,
      414,
      "URI_TOO_LONG",
      "Request URI exceeds maximum allowed length of 2048 bytes",
      ctx.corsOrigin,
    );
    return;
  }

  let parsedUrl: URL;
  try {
    const hostHeader = req.headers.host || "127.0.0.1";
    parsedUrl = new URL(req.url || "/", `http://${hostHeader}`);
  } catch {
    sendError(res, 400, "BAD_REQUEST", "Malformed request URL", ctx.corsOrigin);
    return;
  }

  const pathname = parsedUrl.pathname;

  // Authenticate if token is configured
  if (!isAuthorized(req, pathname, ctx.authToken)) {
    sendError(res, 401, "UNAUTHORIZED", "Missing or invalid Authorization header", ctx.corsOrigin);
    return;
  }

  // Route matching
  const handler = routes[pathname];
  if (!handler) {
    sendError(res, 404, "NOT_FOUND", `Route '${pathname}' not found`, ctx.corsOrigin);
    return;
  }

  try {
    await handler(req, res, parsedUrl, ctx);
  } catch (err) {
    ctx.logger.error({ err, path: pathname }, "Unhandled error executing route handler");
    sendError(res, 500, "INTERNAL_ERROR", "Internal server error", ctx.corsOrigin);
  }
}
