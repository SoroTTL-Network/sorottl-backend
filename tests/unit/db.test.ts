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
    });
  });
});
