import type { ServerResponse } from "node:http";
import type { ApiResponse } from "./types.js";

/**
 * Sends a structured JSON response with security headers.
 */
export function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: ApiResponse,
  corsOrigin?: string,
): void {
  const body = JSON.stringify(payload);
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store, no-cache, must-revalidate",
  };

  if (corsOrigin) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
    headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
  }

  res.writeHead(statusCode, headers);
  res.end(body);
}

/**
 * Sends a structured API error response.
 */
export function sendError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  corsOrigin?: string,
): void {
  sendJson(
    res,
    statusCode,
    {
      success: false,
      error: { code, message },
      timestamp: new Date().toISOString(),
    },
    corsOrigin,
  );
}
