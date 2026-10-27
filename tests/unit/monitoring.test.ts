import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MonitoringService } from "../../src/monitoring/monitoring-service.js";
import { DatabaseClient } from "../../src/db/client.js";
import { createLogger } from "../../src/logging/logger.js";
import type { ISoroRpcClient, LedgerEntry, LatestLedgerInfo } from "@sorottl/sdk";
import { reconstructLedgerKey } from "../../src/watchlist/key-reconstructor.js";

describe("MonitoringService", () => {
  let db: DatabaseClient;
  const logger = createLogger("silent");
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  beforeEach(() => {
    db = new DatabaseClient(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("handles empty watchlist gracefully", async () => {
    const mockRpc: ISoroRpcClient = {
      getLatestLedger: vi.fn(),
      getLatestLedgerSequence: vi.fn(),
      getLedgerEntries: vi.fn(),
      getLedgerEntriesBatch: vi.fn(),
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
      getHealth: vi.fn(),
    };

    const service = new MonitoringService({
      db,
      rpcClient: mockRpc,
      logger,
      network: "testnet",
    });

    const summary = await service.runMonitoringCycle();
    expect(summary.totalKeys).toBe(0);
    expect(summary.alertsTriggered).toBe(0);
    expect(mockRpc.getLatestLedgerSequence).not.toHaveBeenCalled();
  });

  it("monitors live entry above threshold without alerts", async () => {
    const recon = reconstructLedgerKey({
      keyType: "instance",
      contractId,
    });

    db.addWatchlistEntry({
      network: "testnet",
      label: "Live Test",
      keyType: "instance",
      keyXdr: recon.keyXdr,
      contractId,
      warningThresholdLedgers: 1000,
    });

    const mockLatestLedger: LatestLedgerInfo = {
      sequence: 1000,
      protocolVersion: 23,
      id: "abc",
      closeTime: "2026-01-01T00:00:00Z",
    };

    const mockEntry: LedgerEntry = {
      key: recon.key,
      liveUntilLedgerSeq: 3000,
      lastModifiedLedgerSeq: 900,
      entryType: "contractData",
      valXdr: "AAAAAA==",
    };

    const mockRpc: ISoroRpcClient = {
      getLatestLedger: vi.fn().mockResolvedValue(mockLatestLedger),
      getLatestLedgerSequence: vi.fn().mockResolvedValue(1000),
      getLedgerEntry: vi.fn().mockResolvedValue(mockEntry),
      getLedgerEntries: vi.fn().mockResolvedValue([mockEntry]),
      getLedgerEntriesBatch: vi.fn().mockResolvedValue([mockEntry]),
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
      getHealth: vi.fn(),
    };

    const service = new MonitoringService({
      db,
      rpcClient: mockRpc,
      logger,
      network: "testnet",
    });

    const summary = await service.runMonitoringCycle();
    expect(summary.totalKeys).toBe(1);
    expect(summary.liveKeys).toBe(1);
    expect(summary.alertsTriggered).toBe(0);

    const alerts = db.listAlerts();
    expect(alerts).toHaveLength(0);

    const observations = db.getRecentObservations(1, 10);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.remainingLedgers).toBe(2000);
    expect(observations[0]?.status).toBe("live");
  });

  it("triggers threshold alert when remaining TTL is low", async () => {
    const recon = reconstructLedgerKey({
      keyType: "instance",
      contractId,
    });

    const entry = db.addWatchlistEntry({
      network: "testnet",
      label: "Low TTL Test",
      keyType: "instance",
      keyXdr: recon.keyXdr,
      contractId,
      warningThresholdLedgers: 500,
    });

    const mockLatestLedger: LatestLedgerInfo = {
      sequence: 1000,
      protocolVersion: 23,
      id: "abc",
      closeTime: "2026-01-01T00:00:00Z",
    };

    // remaining is 100 ledgers, below threshold 500
    const mockEntry: LedgerEntry = {
      key: recon.key,
      liveUntilLedgerSeq: 1100,
      lastModifiedLedgerSeq: 900,
      entryType: "contractData",
      valXdr: "AAAAAA==",
    };

    const mockRpc: ISoroRpcClient = {
      getLatestLedger: vi.fn().mockResolvedValue(mockLatestLedger),
      getLatestLedgerSequence: vi.fn().mockResolvedValue(1000),
      getLedgerEntry: vi.fn().mockResolvedValue(mockEntry),
      getLedgerEntries: vi.fn().mockResolvedValue([mockEntry]),
      getLedgerEntriesBatch: vi.fn().mockResolvedValue([mockEntry]),
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
      getHealth: vi.fn(),
    };

    const service = new MonitoringService({
      db,
      rpcClient: mockRpc,
      logger,
      network: "testnet",
      alertCooldownMs: 60000,
    });

    const summary1 = await service.runMonitoringCycle();
    expect(summary1.alertsTriggered).toBe(1);

    const alerts1 = db.listAlerts({ watchlistId: entry.id });
    expect(alerts1).toHaveLength(1);
    expect(alerts1[0]?.category).toBe("low_ttl");

    // Run 2nd cycle immediately: alert should be suppressed by cooldown
    const summary2 = await service.runMonitoringCycle();
    expect(summary2.alertsTriggered).toBe(0);
    const alerts2 = db.listAlerts({ watchlistId: entry.id });
    expect(alerts2).toHaveLength(1); // Still 1
  });

  it("isolates errors on per-key basis without failing cycle", async () => {
    const recon1 = reconstructLedgerKey({
      keyType: "instance",
      contractId,
    });

    db.addWatchlistEntry({
      network: "testnet",
      label: "Failing Key",
      keyType: "instance",
      keyXdr: recon1.keyXdr,
      contractId,
    });

    const mockRpc: ISoroRpcClient = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1000, protocolVersion: 23, id: "1" }),
      getLatestLedgerSequence: vi.fn().mockResolvedValue(1000),
      getLedgerEntry: vi.fn().mockRejectedValue(new Error("RPC Timeout")),
      getLedgerEntries: vi.fn().mockRejectedValue(new Error("RPC Timeout")),
      getLedgerEntriesBatch: vi.fn().mockRejectedValue(new Error("RPC Timeout")),
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
      getHealth: vi.fn(),
    };

    const service = new MonitoringService({
      db,
      rpcClient: mockRpc,
      logger,
      network: "testnet",
    });

    const summary = await service.runMonitoringCycle();
    expect(summary.totalKeys).toBe(1);
    expect(summary.errorKeys).toBe(1);
  });

  it("retries transient RPC failures on getLatestLedgerSequence before succeeding", async () => {
    let callCount = 0;
    const mockRpc: ISoroRpcClient = {
      getLatestLedger: vi.fn(),
      getLatestLedgerSequence: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("HTTP 503 Service Unavailable");
        }
        return 12345;
      }),
      getLedgerEntry: vi.fn(),
      getLedgerEntries: vi.fn(),
      getLedgerEntriesBatch: vi.fn(),
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
      getHealth: vi.fn(),
    };

    const service = new MonitoringService({
      db,
      rpcClient: mockRpc,
      logger,
      network: "testnet",
    });

    // Add 1 entry to trigger sequence check
    const recon = reconstructLedgerKey({ keyType: "instance", contractId });
    db.addWatchlistEntry({
      network: "testnet",
      label: "Retry Test",
      keyType: "instance",
      keyXdr: recon.keyXdr,
      contractId,
    });

    const summary = await service.runMonitoringCycle();
    expect(callCount).toBe(2); // Failed once, then retried and succeeded
    expect(summary.errorKeys).toBe(0);
    expect(mockRpc.getLatestLedgerSequence).toHaveBeenCalledTimes(2);
  });

  it("processes multiple keys concurrently with bounded worker pool", async () => {
    const recon1 = reconstructLedgerKey({ keyType: "instance", contractId });
    db.addWatchlistEntry({
      network: "testnet",
      label: "Concurrent 1",
      keyType: "instance",
      keyXdr: recon1.keyXdr,
      contractId,
    });

    const recon2 = reconstructLedgerKey({
      keyType: "contractCode",
      wasmHashHex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    db.addWatchlistEntry({
      network: "testnet",
      label: "Concurrent 2",
      keyType: "contractCode",
      keyXdr: recon2.keyXdr,
    });

    let activeConcurrentQueries = 0;
    let peakConcurrency = 0;

    const mockRpc: ISoroRpcClient = {
      getLatestLedger: vi.fn(),
      getLatestLedgerSequence: vi.fn().mockResolvedValue(2000),
      getLedgerEntry: vi.fn().mockImplementation(async () => {
        activeConcurrentQueries++;
        peakConcurrency = Math.max(peakConcurrency, activeConcurrentQueries);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeConcurrentQueries--;
        return {
          key: recon1.key,
          liveUntilLedgerSeq: 3000,
          entryType: "contractData",
        };
      }),
      getLedgerEntries: vi.fn(),
      getLedgerEntriesBatch: vi.fn(),
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
      getHealth: vi.fn(),
    };

    const service = new MonitoringService({
      db,
      rpcClient: mockRpc,
      logger,
      network: "testnet",
      concurrency: 2,
    });

    const summary = await service.runMonitoringCycle();
    expect(summary.totalKeys).toBe(2);
    expect(summary.liveKeys).toBe(2);
    expect(peakConcurrency).toBeGreaterThanOrEqual(1);
    expect(peakConcurrency).toBeLessThanOrEqual(2);
  });

  it("handles webhook delivery with retries, timeout, and updates delivery status", async () => {
    const entry = db.addWatchlistEntry({
      network: "testnet",
      label: "Webhook Test Item",
      keyType: "instance",
      keyXdr: "AAAAFA==",
    });

    const alert = db.recordAlert({
      watchlistId: entry.id,
      network: "testnet",
      category: "low_ttl",
      title: "Test Webhook Alert",
      message: "Webhook testing",
    });

    let fetchCalls = 0;
    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        throw new Error("HTTP 502 Bad Gateway");
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
      };
    });

    try {
      const mockRpc: ISoroRpcClient = {
        getLatestLedger: vi.fn(),
        getLatestLedgerSequence: vi.fn().mockResolvedValue(100),
        getLedgerEntry: vi.fn(),
        getLedgerEntries: vi.fn(),
        getLedgerEntriesBatch: vi.fn(),
        simulateTransaction: vi.fn(),
        sendTransaction: vi.fn(),
        getTransaction: vi.fn(),
        getHealth: vi.fn(),
      };

      const service = new MonitoringService({
        db,
        rpcClient: mockRpc,
        logger,
        network: "testnet",
        alertWebhookUrl: "https://example.com/webhook",
      });

      const delivered = await service.dispatchWebhook(alert.id, alert.title, alert.message);
      expect(delivered).toBe(true);
      expect(fetchCalls).toBe(2); // Retried once on 502 and succeeded

      // Verify SQLite delivery update
      const updatedAlert = db.listAlerts({ watchlistId: entry.id })[0];
      expect(updatedAlert?.deliveryStatus).toBe("delivered");
      expect(updatedAlert?.delivered).toBe(true);
      expect(updatedAlert?.deliveredAt).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reconciles pending webhook alerts on startup without duplicates", async () => {
    const entry = db.addWatchlistEntry({
      network: "testnet",
      label: "Pending Reconciliation Test",
      keyType: "instance",
      keyXdr: "BBBBFA==",
    });

    // Alert 1: Pending (eligible)
    const alert1 = db.recordAlert({
      watchlistId: entry.id,
      network: "testnet",
      category: "low_ttl",
      title: "Pending Alert 1",
      message: "Needs reconciliation",
    });

    // Alert 2: Already delivered (must not be resent)
    const alert2 = db.recordAlert({
      watchlistId: entry.id,
      network: "testnet",
      category: "low_ttl",
      title: "Already Delivered Alert",
      message: "Do not resend",
    });
    db.updateAlertDelivery(alert2.id, "delivered");

    // Alert 3: Failed with exhausted attempts (attempts = 5, must not be resent)
    const alert3 = db.recordAlert({
      watchlistId: entry.id,
      network: "testnet",
      category: "low_ttl",
      title: "Exhausted Alert",
      message: "Exceeded max attempts",
    });
    db["db"].exec(
      `UPDATE alerts SET delivery_attempts = 5, delivery_status = 'failed' WHERE id = ${alert3.id};`,
    );

    let sentAlertIds: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body as string);
      sentAlertIds.push(body.alertId);
      return { ok: true, status: 200, statusText: "OK" };
    });

    try {
      const mockRpc: ISoroRpcClient = {
        getLatestLedger: vi.fn(),
        getLatestLedgerSequence: vi.fn().mockResolvedValue(100),
        getLedgerEntry: vi.fn(),
        getLedgerEntries: vi.fn(),
        getLedgerEntriesBatch: vi.fn(),
        simulateTransaction: vi.fn(),
        sendTransaction: vi.fn(),
        getTransaction: vi.fn(),
        getHealth: vi.fn(),
      };

      const service = new MonitoringService({
        db,
        rpcClient: mockRpc,
        logger,
        network: "testnet",
        alertWebhookUrl: "https://example.com/webhook",
      });

      const reconciledCount = await service.reconcilePendingAlerts(10);
      expect(reconciledCount).toBe(1);
      expect(sentAlertIds).toEqual([alert1.id]);

      // Verify alert 1 is now marked delivered in DB
      const freshAlert1 = db.listAlerts({ watchlistId: entry.id }).find((a) => a.id === alert1.id);
      expect(freshAlert1?.deliveryStatus).toBe("delivered");
      expect(freshAlert1?.delivered).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prevents concurrent dispatch of the same alert ID within one process", async () => {
    const entry = db.addWatchlistEntry({
      network: "testnet",
      label: "Concurrent Dedup Test",
      keyType: "instance",
      keyXdr: "CCCCFA==",
    });

    const alert = db.recordAlert({
      watchlistId: entry.id,
      network: "testnet",
      category: "low_ttl",
      title: "Concurrent Alert",
      message: "Testing dedup lock",
    });

    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true, status: 200, statusText: "OK" };
    });

    try {
      const mockRpc: ISoroRpcClient = {
        getLatestLedger: vi.fn(),
        getLatestLedgerSequence: vi.fn().mockResolvedValue(100),
        getLedgerEntry: vi.fn(),
        getLedgerEntries: vi.fn(),
        getLedgerEntriesBatch: vi.fn(),
        simulateTransaction: vi.fn(),
        sendTransaction: vi.fn(),
        getTransaction: vi.fn(),
        getHealth: vi.fn(),
      };

      const service = new MonitoringService({
        db,
        rpcClient: mockRpc,
        logger,
        network: "testnet",
        alertWebhookUrl: "https://example.com/webhook",
      });

      // Launch two simultaneous dispatches for the same alert
      const [res1, res2] = await Promise.all([
        service.dispatchWebhook(alert.id, alert.title, alert.message),
        service.dispatchWebhook(alert.id, alert.title, alert.message),
      ]);

      // Exactly one should dispatch; the other should detect active dispatch and return false
      expect(fetchCount).toBe(1);
      expect([res1, res2].filter(Boolean)).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
