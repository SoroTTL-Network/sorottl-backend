import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import { HttpServer } from "../../src/server/index.js";
import { DatabaseClient } from "../../src/db/client.js";
import { createLogger } from "../../src/logging/logger.js";
import type { ISoroRpcClient } from "@sorottl/sdk";

// Helper to perform HTTP GET requests against test server
function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode || 0,
              body: JSON.parse(data) as Record<string, unknown>,
            });
          } catch {
            resolve({ status: res.statusCode || 0, body: { raw: data } });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function requestRaw(
  url: string,
  method: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: data, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("HttpServer Read-Only API", () => {
  let db: DatabaseClient;
  let server: HttpServer;
  let baseUrl: string;
  const logger = createLogger("silent");

  const mockRpc: ISoroRpcClient = {
    getLatestLedger: vi
      .fn()
      .mockResolvedValue({ sequence: 500000, protocolVersion: 23, id: "ledger-500k" }),
    getLatestLedgerSequence: vi.fn().mockResolvedValue(500000),
    getLedgerEntry: vi.fn(),
    getLedgerEntries: vi.fn(),
    getLedgerEntriesBatch: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
    getHealth: vi.fn().mockResolvedValue({ status: "healthy" }),
  };

  beforeEach(async () => {
    db = new DatabaseClient(":memory:");
    // Bind to port 0 for dynamic ephemeral port allocation
    server = new HttpServer({
      db,
      rpcClient: mockRpc,
      logger,
      port: 0,
      host: "127.0.0.1",
      network: "testnet",
    });
    const bound = await server.start();
    baseUrl = `http://127.0.0.1:${bound.port}`;
  });

  afterEach(async () => {
    await server.stop();
    try {
      db.close();
    } catch {
      // Ignored if test already closed db
    }
  });

  describe("Health Endpoints", () => {
    it("GET /health returns 200 with healthy state when DB and RPC are up", async () => {
      const res = await getJson(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("healthy");
      expect(res.body.data.database).toBe("connected");
      expect(res.body.data.rpc).toBe("reachable");
      expect(res.body.data.currentLedger).toBe(500000);
      expect(res.body.data.network).toBe("testnet");
    });

    it("GET /health reports degraded RPC without failing overall health probe with 503", async () => {
      const failingRpc: ISoroRpcClient = {
        ...mockRpc,
        getLatestLedger: vi.fn().mockRejectedValue(new Error("RPC network unreachable")),
      };
      const localServer = new HttpServer({
        db,
        rpcClient: failingRpc,
        logger,
        port: 0,
        host: "127.0.0.1",
      });
      const bound = await localServer.start();
      try {
        const res = await getJson(`http://127.0.0.1:${bound.port}/health`);
        // DB is healthy, so service process is ready; RPC is marked unreachable
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.database).toBe("connected");
        expect(res.body.data.rpc).toBe("unreachable");
      } finally {
        await localServer.stop();
      }
    });

    it("GET /health/live returns 200 alive", async () => {
      const res = await getJson(`${baseUrl}/health/live`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("alive");
      expect(typeof res.body.data.uptimeSeconds).toBe("number");
    });

    it("GET /health/ready returns 200 when DB is connected", async () => {
      const res = await getJson(`${baseUrl}/health/ready`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("ready");
      expect(res.body.data.database).toBe("connected");
    });

    it("GET /health/ready returns 503 if database is closed or corrupted", async () => {
      db.close();
      const res = await getJson(`${baseUrl}/health/ready`);
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("NOT_READY");
    });
  });

  describe("Watchlist Endpoint", () => {
    it("GET /api/v1/watchlist returns empty array on empty database", async () => {
      const res = await getJson(`${baseUrl}/api/v1/watchlist`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
      expect(res.body.pagination).toEqual({ limit: 50, offset: 0, returned: 0 });
    });

    it("GET /api/v1/watchlist returns augmented records and supports pagination", async () => {
      const entry1 = db.addWatchlistEntry({
        network: "testnet",
        label: "Contract 1",
        keyType: "instance",
        keyXdr: "AAAAFA==",
      });
      const entry2 = db.addWatchlistEntry({
        network: "testnet",
        label: "Contract 2",
        keyType: "contractCode",
        keyXdr: "BBBBFA==",
      });

      // Record observation for entry1
      db.recordObservation({
        watchlistId: entry1.id,
        network: "testnet",
        currentLedger: 1000,
        liveUntilLedgerSeq: 15000,
        remainingLedgers: 14000,
        status: "live",
        durability: "instance",
        confidence: "authoritative",
      });

      // Fetch with limit 1
      const res = await getJson(`${baseUrl}/api/v1/watchlist?limit=1&offset=0`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(entry1.id);
      expect(res.body.data[0].latestObservation).not.toBeNull();
      expect(res.body.data[0].latestObservation.status).toBe("live");
      expect(res.body.data[0].latestObservation.remainingLedgers).toBe(14000);
      expect(res.body.pagination).toEqual({ limit: 1, offset: 0, returned: 1 });

      // Offset 1
      const res2 = await getJson(`${baseUrl}/api/v1/watchlist?limit=1&offset=1`);
      expect(res2.status).toBe(200);
      expect(res2.body.data).toHaveLength(1);
      expect(res2.body.data[0].id).toBe(entry2.id);
      expect(res2.body.data[0].latestObservation).toBeNull();
    });

    it("rejects invalid query parameters on watchlist route", async () => {
      const res1 = await getJson(`${baseUrl}/api/v1/watchlist?limit=500`);
      expect(res1.status).toBe(400);
      expect(res1.body.error.code).toBe("INVALID_PARAMETER");

      const res2 = await getJson(`${baseUrl}/api/v1/watchlist?network=invalid_net`);
      expect(res2.status).toBe(400);

      const res3 = await getJson(`${baseUrl}/api/v1/watchlist?enabledOnly=not_a_bool`);
      expect(res3.status).toBe(400);
    });
  });

  describe("Observations Endpoint", () => {
    it("GET /api/v1/observations returns observations with filtering", async () => {
      const entry = db.addWatchlistEntry({
        network: "testnet",
        label: "Obs Contract",
        keyType: "instance",
        keyXdr: "CCCCFA==",
      });

      db.recordObservation({
        watchlistId: entry.id,
        network: "testnet",
        currentLedger: 100,
        liveUntilLedgerSeq: 200,
        remainingLedgers: 100,
        status: "live",
        durability: "instance",
        confidence: "authoritative",
      });

      db.recordObservation({
        watchlistId: entry.id,
        network: "testnet",
        currentLedger: 200,
        liveUntilLedgerSeq: 200,
        remainingLedgers: 0,
        status: "ttlReached",
        durability: "instance",
        confidence: "authoritative",
      });

      const resAll = await getJson(`${baseUrl}/api/v1/observations?watchlistId=${entry.id}`);
      expect(resAll.status).toBe(200);
      expect(resAll.body.data).toHaveLength(2);

      const resFilter = await getJson(`${baseUrl}/api/v1/observations?status=ttlReached`);
      expect(resFilter.status).toBe(200);
      expect(resFilter.body.data).toHaveLength(1);
      expect(resFilter.body.data[0].status).toBe("ttlReached");
    });

    it("rejects invalid status filter on observations", async () => {
      const res = await getJson(`${baseUrl}/api/v1/observations?status=malicious_status`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_PARAMETER");
    });
  });

  describe("Alerts Endpoint", () => {
    it("GET /api/v1/alerts returns alerts and filters by category and delivery status", async () => {
      const entry = db.addWatchlistEntry({
        network: "testnet",
        label: "Alert Test",
        keyType: "instance",
        keyXdr: "DDDDFA==",
      });

      const a1 = db.recordAlert({
        watchlistId: entry.id,
        network: "testnet",
        category: "low_ttl",
        title: "Low TTL Alert",
        message: "Expiring soon",
      });

      db.recordAlert({
        watchlistId: entry.id,
        network: "testnet",
        category: "unknown_status",
        title: "Unknown Status Alert",
        message: "Status unknown",
      });

      db.updateAlertDelivery(a1.id, "delivered");

      const resDelivered = await getJson(`${baseUrl}/api/v1/alerts?deliveryStatus=delivered`);
      expect(resDelivered.status).toBe(200);
      expect(resDelivered.body.data).toHaveLength(1);
      expect(resDelivered.body.data[0].category).toBe("low_ttl");

      const resUnknown = await getJson(`${baseUrl}/api/v1/alerts?category=unknown_status`);
      expect(resUnknown.status).toBe(200);
      expect(resUnknown.body.data).toHaveLength(1);
      expect(resUnknown.body.data[0].category).toBe("unknown_status");
    });
  });

  describe("CORS and Security Invariants", () => {
    it("does not emit Access-Control-Allow-Origin header when corsOrigin is unset", async () => {
      // server default in beforeEach has no corsOrigin
      const res = await requestRaw(`${baseUrl}/api/v1/watchlist`, "GET", {
        Origin: "https://malicious.example.com",
      });
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("emits configured corsOrigin and does not echo arbitrary disallowed origins", async () => {
      const corsServer = new HttpServer({
        db,
        rpcClient: mockRpc,
        logger,
        port: 0,
        host: "127.0.0.1",
        corsOrigin: "https://trusted-dashboard.example.com",
      });
      const bound = await corsServer.start();
      const testUrl = `http://127.0.0.1:${bound.port}`;

      try {
        // Request from unauthorized origin still only gets the configured trusted origin
        const res = await requestRaw(`${testUrl}/api/v1/watchlist`, "GET", {
          Origin: "https://untrusted.attacker.com",
        });
        expect(res.status).toBe(200);
        expect(res.headers["access-control-allow-origin"]).toBe(
          "https://trusted-dashboard.example.com",
        );

        // Preflight OPTIONS request
        const optionsRes = await requestRaw(`${testUrl}/api/v1/watchlist`, "OPTIONS", {
          Origin: "https://untrusted.attacker.com",
        });
        expect(optionsRes.status).toBe(204);
        expect(optionsRes.headers["access-control-allow-origin"]).toBe(
          "https://trusted-dashboard.example.com",
        );
      } finally {
        await corsServer.stop();
      }
    });

    it("does not leak secret tokens or internal database errors in error responses", async () => {
      const secretToken = "super-secret-token-xyz-12345";
      const secureServer = new HttpServer({
        db,
        logger,
        port: 0,
        host: "127.0.0.1",
        authToken: secretToken,
      });
      const bound = await secureServer.start();
      const testUrl = `http://127.0.0.1:${bound.port}`;

      try {
        // Malformed bearer token
        const res1 = await getJson(`${testUrl}/api/v1/watchlist`, {
          Authorization: "Basic invalid-credentials",
        });
        expect(res1.status).toBe(401);
        expect(JSON.stringify(res1.body)).not.toContain(secretToken);

        // Wrong token
        const res2 = await getJson(`${testUrl}/api/v1/watchlist`, {
          Authorization: "Bearer wrong-token-54321",
        });
        expect(res2.status).toBe(401);
        expect(JSON.stringify(res2.body)).not.toContain(secretToken);
        expect(JSON.stringify(res2.body)).not.toContain("wrong-token-54321");
      } finally {
        await secureServer.stop();
      }
    });

    it("shuts down cleanly alongside keeper without leaving hanging handles", async () => {
      const keeper = {
        isRunning: () => true,
        stop: vi.fn().mockResolvedValue(undefined),
      };
      const coServer = new HttpServer({
        db,
        logger,
        port: 0,
        host: "127.0.0.1",
        isKeeperRunning: () => keeper.isRunning(),
      });
      const bound = await coServer.start();
      expect(coServer.isListening()).toBe(true);

      const healthRes = await getJson(`http://127.0.0.1:${bound.port}/health`);
      expect(healthRes.body.data.keeperRunning).toBe(true);

      // Simulate simultaneous component shutdown (as executed in CLI shutdown handler)
      await Promise.allSettled([keeper.stop(), coServer.stop()]);
      expect(coServer.isListening()).toBe(false);
      expect(keeper.stop).toHaveBeenCalledTimes(1);

      // Verify db is still open and uncorrupted
      expect(() => db.listWatchlist()).not.toThrow();
    });

    it("rejects non-GET and non-HEAD methods with 405 Method Not Allowed", async () => {
      const postRes = await requestRaw(`${baseUrl}/api/v1/watchlist`, "POST");
      expect(postRes.status).toBe(405);
      const postBody = JSON.parse(postRes.body);
      expect(postBody.error.code).toBe("METHOD_NOT_ALLOWED");

      const deleteRes = await requestRaw(`${baseUrl}/api/v1/alerts`, "DELETE");
      expect(deleteRes.status).toBe(405);
    });

    it("returns 404 Not Found for unknown routes", async () => {
      const res = await getJson(`${baseUrl}/api/v1/non_existent_route`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("enforces Bearer token authentication when configured", async () => {
      const secureServer = new HttpServer({
        db,
        rpcClient: mockRpc,
        logger,
        port: 0,
        host: "127.0.0.1",
        authToken: "super-secret-token-12345",
      });
      const bound = await secureServer.start();
      const secureUrl = `http://127.0.0.1:${bound.port}`;

      try {
        // Health routes remain accessible without auth
        const healthRes = await getJson(`${secureUrl}/health`);
        expect(healthRes.status).toBe(200);

        // API routes fail without token
        const unauthRes = await getJson(`${secureUrl}/api/v1/watchlist`);
        expect(unauthRes.status).toBe(401);
        expect(unauthRes.body.error.code).toBe("UNAUTHORIZED");

        // API routes fail with wrong token
        const wrongRes = await getJson(`${secureUrl}/api/v1/watchlist`, {
          Authorization: "Bearer wrong-token",
        });
        expect(wrongRes.status).toBe(401);

        // API routes succeed with correct token
        const authRes = await getJson(`${secureUrl}/api/v1/watchlist`, {
          Authorization: "Bearer super-secret-token-12345",
        });
        expect(authRes.status).toBe(200);
      } finally {
        await secureServer.stop();
      }
    });

    it("handles non-loopback host binding logging warning", async () => {
      const warnSpy = vi.spyOn(logger, "warn");
      const extServer = new HttpServer({
        db,
        rpcClient: mockRpc,
        logger,
        port: 0,
        host: "0.0.0.0",
      });
      await extServer.start();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ host: "0.0.0.0" }),
        expect.stringContaining("[SECURITY WARNING]"),
      );
      await extServer.stop();
    });

    it("gracefully shuts down without closing database connection needed by caller", async () => {
      await server.stop();
      expect(server.isListening()).toBe(false);
      // DB connection should remain open for caller/keeper
      expect(() => db.listWatchlist()).not.toThrow();
    });

    it("rejects oversized request targets with 414 URI Too Long", async () => {
      const longPath = "/api/v1/watchlist?" + "a".repeat(2500);
      const res = await getJson(`${baseUrl}${longPath}`);
      expect(res.status).toBe(414);
      const err = res.body.error as { code: string } | undefined;
      expect(err?.code).toBe("URI_TOO_LONG");
    });

    it("handles port conflicts gracefully by rejecting startup promise", async () => {
      const boundPort = server.getPort();
      const conflictingServer = new HttpServer({
        db,
        logger,
        port: boundPort,
        host: "127.0.0.1",
      });

      await expect(conflictingServer.start()).rejects.toThrow();
      expect(conflictingServer.isListening()).toBe(false);
    });

    it("coalesces concurrent health checks to prevent RPC flooding", async () => {
      const spy = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { sequence: 600000, protocolVersion: 23, id: "ledger-600k" };
      });
      const rpcWithSlowProbe: ISoroRpcClient = {
        ...mockRpc,
        getLatestLedger: spy,
      };

      const customServer = new HttpServer({
        db,
        rpcClient: rpcWithSlowProbe,
        logger,
        port: 0,
        host: "127.0.0.1",
      });
      const bound = await customServer.start();

      try {
        const [res1, res2, res3] = await Promise.all([
          getJson(`http://127.0.0.1:${bound.port}/health`),
          getJson(`http://127.0.0.1:${bound.port}/health`),
          getJson(`http://127.0.0.1:${bound.port}/health`),
        ]);

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(res3.status).toBe(200);
        // Calls were coalesced into a single probe
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        await customServer.stop();
      }
    });
  });
});
