import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KeeperDaemon } from "../../src/monitoring/keeper.js";
import { MonitoringService } from "../../src/monitoring/monitoring-service.js";
import { DatabaseClient } from "../../src/db/client.js";
import { createLogger } from "../../src/logging/logger.js";
import type { ISoroRpcClient } from "@sorottl/sdk";

describe("KeeperDaemon Lifecycle", () => {
  let db: DatabaseClient;
  const logger = createLogger("silent");

  beforeEach(() => {
    db = new DatabaseClient(":memory:");
    vi.useFakeTimers();
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("starts and stops cleanly", async () => {
    const mockRpc: ISoroRpcClient = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100, protocolVersion: 23, id: "1" }),
      getLedgerEntries: vi.fn().mockResolvedValue([]),
      getLedgerEntriesBatch: vi.fn().mockResolvedValue([]),
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

    const keeper = new KeeperDaemon({
      monitoringService: service,
      logger,
      intervalMs: 1000,
    });

    expect(keeper.isRunning()).toBe(false);

    // Start keeper
    const startPromise = keeper.start();
    // Advance timer slightly to allow immediate initial cycle
    await vi.advanceTimersByTimeAsync(10);

    expect(keeper.isRunning()).toBe(true);

    // Stop keeper
    keeper.stop();
    await startPromise;

    expect(keeper.isRunning()).toBe(false);
  });

  it("prevents overlapping monitoring runs", async () => {
    const runSpy = vi.fn().mockImplementation(async () => {
      // Simulate slow run
      await new Promise((res) => setTimeout(res, 5000));
      return {
        cycleId: "test",
        network: "testnet",
        startedAt: "",
        completedAt: "",
        durationMs: 0,
        totalEntries: 0,
        activeEntries: 0,
        failedEntries: 0,
        statusBreakdown: { live: 0, ttlReached: 0, unknown: 0, error: 0 },
        alertsTriggered: 0,
      };
    });

    const mockService = {
      runMonitoringCycle: runSpy,
    } as unknown as MonitoringService;

    const keeper = new KeeperDaemon({
      monitoringService: mockService,
      logger,
      intervalMs: 1000,
    });

    const startPromise = keeper.start();

    // Trigger initial cycle
    await vi.advanceTimersByTimeAsync(10);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Advance by interval (1000ms), but previous run is still running (needs 5000ms)
    await vi.advanceTimersByTimeAsync(1000);
    // Should NOT have called runMonitoringCycle a second time due to mutex
    expect(runSpy).toHaveBeenCalledTimes(1);

    keeper.stop();
    // Advance timers so pending promise resolves
    await vi.advanceTimersByTimeAsync(6000);
    await startPromise;
  });

  it("handles unhandled exception during monitoring cycle without crashing daemon", async () => {
    const errorSpy = vi.fn().mockRejectedValue(new Error("Fatal cycle panic"));
    const mockService = {
      runMonitoringCycle: errorSpy,
    } as unknown as MonitoringService;

    const keeper = new KeeperDaemon({
      monitoringService: mockService,
      logger,
      intervalMs: 1000,
    });

    keeper.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Daemon should still remain running despite exception in cycle
    expect(keeper.isRunning()).toBe(true);

    keeper.stop();
    expect(keeper.isRunning()).toBe(false);
  });
});
