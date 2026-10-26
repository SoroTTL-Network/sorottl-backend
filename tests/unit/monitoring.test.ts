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
});
