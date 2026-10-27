import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseClient } from "../../src/db/client.js";

describe("SQLite Database Client", () => {
  let db: DatabaseClient;

  beforeEach(() => {
    // In-memory sqlite database for fast, isolated unit testing
    db = new DatabaseClient(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("Watchlist Operations", () => {
    it("adds and retrieves watchlist entries", () => {
      const entry = db.addWatchlistEntry({
        network: "testnet",
        label: "Governance Contract Instance",
        keyType: "instance",
        keyXdr: "AAAAFA==",
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        warningThresholdLedgers: 5000,
      });

      expect(entry.id).toBeGreaterThan(0);
      expect(entry.network).toBe("testnet");
      expect(entry.label).toBe("Governance Contract Instance");
      expect(entry.keyType).toBe("instance");
      expect(entry.keyXdr).toBe("AAAAFA==");
      expect(entry.contractId).toBe("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM");
      expect(entry.warningThresholdLedgers).toBe(5000);
      expect(entry.enabled).toBe(true);

      const list = db.listWatchlist({ network: "testnet" });
      expect(list).toHaveLength(1);
      expect(list[0]?.label).toBe("Governance Contract Instance");
    });

    it("prevents duplicate (network, keyXdr) insertion", () => {
      db.addWatchlistEntry({
        network: "testnet",
        label: "Entry 1",
        keyType: "instance",
        keyXdr: "AAAAFA==",
      });

      expect(() => {
        db.addWatchlistEntry({
          network: "testnet",
          label: "Entry 2",
          keyType: "instance",
          keyXdr: "AAAAFA==",
        });
      }).toThrow(/UNIQUE constraint failed/i);
    });

    it("allows same keyXdr on different networks", () => {
      db.addWatchlistEntry({
        network: "testnet",
        label: "Testnet Entry",
        keyType: "instance",
        keyXdr: "AAAAFA==",
      });

      const mainnetEntry = db.addWatchlistEntry({
        network: "mainnet",
        label: "Mainnet Entry",
        keyType: "instance",
        keyXdr: "AAAAFA==",
      });

      expect(mainnetEntry.id).toBeGreaterThan(0);
      expect(db.listWatchlist({ network: "testnet" })).toHaveLength(1);
      expect(db.listWatchlist({ network: "mainnet" })).toHaveLength(1);
    });

    it("enables and disables watchlist items", () => {
      const entry = db.addWatchlistEntry({
        network: "testnet",
        label: "Toggle Entry",
        keyType: "contractCode",
        keyXdr: "BBBBFA==",
      });

      expect(db.listWatchlist({ enabledOnly: true })).toHaveLength(1);

      const updated = db.setWatchlistEnabled(entry.id, false);
      expect(updated).toBe(true);
      expect(db.listWatchlist({ enabledOnly: true })).toHaveLength(0);
      expect(db.listWatchlist({ enabledOnly: false })).toHaveLength(1);

      db.setWatchlistEnabled(entry.id, true);
      expect(db.listWatchlist({ enabledOnly: true })).toHaveLength(1);
    });
  });

  describe("Observations and Alerts", () => {
    it("records TTL observations correctly", () => {
      const entry = db.addWatchlistEntry({
        network: "testnet",
        label: "Observability Test",
        keyType: "instance",
        keyXdr: "CCCCFA==",
      });

      const obs = db.recordObservation({
        watchlistId: entry.id,
        network: "testnet",
        currentLedger: 1000,
        liveUntilLedgerSeq: 1500,
        remainingLedgers: 500,
        lastModifiedLedgerSeq: 950,
        status: "live",
        durability: "persistent",
        confidence: "exact_ttl_entry",
        reason: "Valid live entry",
      });

      expect(obs.id).toBeGreaterThan(0);
      expect(obs.watchlistId).toBe(entry.id);
      expect(obs.currentLedger).toBe(1000);
      expect(obs.remainingLedgers).toBe(500);
      expect(obs.status).toBe("live");

      const recent = db.getRecentObservations(entry.id, 10);
      expect(recent).toHaveLength(1);
      expect(recent[0]?.remainingLedgers).toBe(500);
    });

    it("creates alerts and respects cooldown window", () => {
      const entry = db.addWatchlistEntry({
        network: "testnet",
        label: "Alert Test",
        keyType: "instance",
        keyXdr: "DDDDFA==",
      });

      // No alert initially in cooldown
      expect(db.isAlertInCooldown(entry.id, "threshold_exceeded", 60000)).toBe(false);

      const alert = db.createAlert({
        watchlistId: entry.id,
        network: "testnet",
        category: "threshold_exceeded",
        currentLedger: 1000,
        liveUntilLedgerSeq: 1050,
        remainingLedgers: 50,
        thresholdLedgers: 100,
        message: "Remaining TTL 50 is below threshold 100",
      });

      expect(alert.id).toBeGreaterThan(0);
      expect(alert.category).toBe("threshold_exceeded");

      // Now inside 60 second cooldown window
      expect(db.isAlertInCooldown(entry.id, "threshold_exceeded", 60000)).toBe(true);

      // Different category is not in cooldown
      expect(db.isAlertInCooldown(entry.id, "ttl_reached", 60000)).toBe(false);

      const alerts = db.listAlerts({ watchlistId: entry.id });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.category).toBe("threshold_exceeded");
      expect(alerts[0]?.deliveryStatus).toBe("pending");
      expect(alerts[0]?.deliveryAttempts).toBe(0);
    });

    it("tracks alert delivery status transitions", () => {
      const entry = db.addWatchlistEntry({
        network: "testnet",
        label: "Delivery Status Test",
        keyType: "instance",
        keyXdr: "EEEEFA==",
      });

      const alert = db.recordAlert({
        watchlistId: entry.id,
        network: "testnet",
        category: "low_ttl",
        title: "Test Low TTL",
        message: "Testing status tracking",
      });

      expect(alert.deliveryStatus).toBe("pending");
      expect(alert.delivered).toBe(false);
      expect(alert.deliveryAttempts).toBe(0);

      // 1. Record delivery failure
      db.updateAlertDelivery(alert.id, "failed", "HTTP 503 Service Unavailable");
      const afterFailure = db.listAlerts({ watchlistId: entry.id })[0];
      expect(afterFailure?.deliveryStatus).toBe("failed");
      expect(afterFailure?.delivered).toBe(false);
      expect(afterFailure?.deliveryAttempts).toBe(1);
      expect(afterFailure?.lastDeliveryError).toBe("HTTP 503 Service Unavailable");

      // 2. Record delivery success
      db.updateAlertDelivery(alert.id, "delivered");
      const afterSuccess = db.listAlerts({ watchlistId: entry.id })[0];
      expect(afterSuccess?.deliveryStatus).toBe("delivered");
      expect(afterSuccess?.delivered).toBe(true);
      expect(afterSuccess?.deliveryAttempts).toBe(2);
      expect(afterSuccess?.deliveredAt).toBeDefined();
    });
  });

  describe("Schema Migrations and Filesystem Hardening", () => {
    it("creates parent directory automatically if dbPath is in a nested directory", () => {
      const tempNestedDir = path.resolve(process.cwd(), "tmp_test_nested_dir/sub/test.db");
      const nestedClient = new DatabaseClient(tempNestedDir);

      try {
        expect(fs.existsSync(tempNestedDir)).toBe(true);
        const record = nestedClient.addWatchlistEntry({
          network: "testnet",
          label: "Nested Dir Test",
          keyType: "instance",
          keyXdr: "FFFFFA==",
        });
        expect(record.id).toBeGreaterThan(0);
      } finally {
        nestedClient.close();
        // Clean up temporary directory
        fs.rmSync(path.resolve(process.cwd(), "tmp_test_nested_dir"), {
          recursive: true,
          force: true,
        });
      }
    });

    it("rejects database file with newer unsupported schema version", () => {
      const tempDbPath = path.resolve(process.cwd(), "tmp_future_version.db");
      if (fs.existsSync(tempDbPath)) {
        fs.rmSync(tempDbPath, { force: true });
      }

      const client = new DatabaseClient(tempDbPath);
      // Simulate future version 99
      client["setSchemaVersion"](99);
      client.close();

      try {
        expect(() => new DatabaseClient(tempDbPath)).toThrow(/newer than supported version/i);
      } finally {
        if (fs.existsSync(tempDbPath)) {
          fs.rmSync(tempDbPath, { force: true });
        }
      }
    });
  });

  describe("Transactional Retention & Pruning", () => {
    it("prunes observations older than cutoff while preserving recent records and watchlist", () => {
      const entry = db.addWatchlistEntry({
        network: "testnet",
        label: "Prune Test Item",
        keyType: "instance",
        keyXdr: "GGGGFA==",
      });

      // Insert older observation
      db.recordObservation({
        watchlistId: entry.id,
        network: "testnet",
        currentLedger: 500,
        status: "live",
        durability: "instance",
        confidence: "authoritative",
      });

      // Manually backdate the observation in SQLite
      db["db"].exec("UPDATE ttl_observations SET observed_at = '2025-01-01T00:00:00Z';");

      // Insert recent observation
      db.recordObservation({
        watchlistId: entry.id,
        network: "testnet",
        currentLedger: 1000,
        status: "live",
        durability: "instance",
        confidence: "authoritative",
      });

      expect(db.getRecentObservations(entry.id, 10)).toHaveLength(2);

      // Prune with cutoff 2025-06-01
      const prunedCount = db.pruneObservations("2025-06-01T00:00:00Z");
      expect(prunedCount).toBe(1);

      // Remaining observation should be the recent one
      const remaining = db.getRecentObservations(entry.id, 10);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.currentLedger).toBe(1000);

      // Watchlist item must never be deleted by observation pruning
      expect(db.listWatchlist({ network: "testnet" })).toHaveLength(1);
    });

    it("prunes delivered alerts older than cutoff, but NEVER prunes undelivered/pending alerts", () => {
      const entry = db.addWatchlistEntry({
        network: "testnet",
        label: "Alert Prune Item",
        keyType: "instance",
        keyXdr: "HHHHFA==",
      });

      // Alert 1: Old and DELIVERED
      const alert1 = db.recordAlert({
        watchlistId: entry.id,
        network: "testnet",
        category: "low_ttl",
        title: "Old Delivered Alert",
        message: "Old delivered",
      });
      db.updateAlertDelivery(alert1.id, "delivered");
      db["db"].exec(
        `UPDATE alerts SET created_at = '2025-01-01T00:00:00Z' WHERE id = ${alert1.id};`,
      );

      // Alert 2: Old but PENDING (undelivered)
      const alert2 = db.recordAlert({
        watchlistId: entry.id,
        network: "testnet",
        category: "ttl_reached",
        title: "Old Pending Alert",
        message: "Old pending",
      });
      db["db"].exec(
        `UPDATE alerts SET created_at = '2025-01-01T00:00:00Z' WHERE id = ${alert2.id};`,
      );

      // Alert 3: Old but FAILED (undelivered)
      const alert3 = db.recordAlert({
        watchlistId: entry.id,
        network: "testnet",
        category: "rpc_failure",
        title: "Old Failed Alert",
        message: "Old failed",
      });
      db.updateAlertDelivery(alert3.id, "failed", "Network down");
      db["db"].exec(
        `UPDATE alerts SET created_at = '2025-01-01T00:00:00Z' WHERE id = ${alert3.id};`,
      );

      // Alert 4: Recent and DELIVERED
      const alert4 = db.recordAlert({
        watchlistId: entry.id,
        network: "testnet",
        category: "low_ttl",
        title: "Recent Delivered Alert",
        message: "Recent delivered",
      });
      db.updateAlertDelivery(alert4.id, "delivered");

      expect(db.listAlerts({ watchlistId: entry.id })).toHaveLength(4);

      // Prune with cutoff 2025-06-01
      const pruned = db.pruneAlerts("2025-06-01T00:00:00Z");
      // Only Alert 1 should be pruned (it was older than cutoff AND delivered)
      expect(pruned).toBe(1);

      const remainingAlerts = db.listAlerts({ watchlistId: entry.id });
      expect(remainingAlerts).toHaveLength(3);
      const remainingIds = remainingAlerts.map((a) => a.id);
      expect(remainingIds).not.toContain(alert1.id);
      expect(remainingIds).toContain(alert2.id); // preserved because undelivered
      expect(remainingIds).toContain(alert3.id); // preserved because failed delivery
      expect(remainingIds).toContain(alert4.id); // preserved because recent

      // Watchlist item must never be deleted
      expect(db.listWatchlist({ network: "testnet" })).toHaveLength(1);
    });
  });
});
