import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AlertCategory,
  AlertDeliveryStatus,
  AlertRecord,
  CreateAlertInput,
  CreateObservationInput,
  CreateWatchlistInput,
  TTLObservationRecord,
  WatchlistRecord,
} from "../types/domain.js";

/**
 * Current target database schema version.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * SQLite database client managing migrations and typed CRUD operations.
 */
export class DatabaseClient {
  private readonly db: DatabaseSync;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      const parentDir = path.dirname(path.resolve(dbPath));
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(dbPath);
    try {
      this.initPragmas();
      this.runMigrations();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  private initPragmas(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  private getSchemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version;").get() as
      Record<string, unknown> | undefined;
    return row && typeof row["user_version"] === "number" ? row["user_version"] : 0;
  }

  private setSchemaVersion(version: number): void {
    this.db.exec(`PRAGMA user_version = ${version};`);
  }

  private runMigrations(): void {
    const currentVersion = this.getSchemaVersion();

    if (currentVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${currentVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}. Please update the SoroTTL backend.`,
      );
    }

    // Migration v1: Initial tables
    if (currentVersion < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS watchlist (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          network TEXT NOT NULL,
          label TEXT NOT NULL,
          key_type TEXT NOT NULL,
          key_xdr TEXT NOT NULL,
          contract_id TEXT,
          warning_threshold_ledgers INTEGER NOT NULL DEFAULT 5000,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(network, key_xdr)
        );
        CREATE INDEX IF NOT EXISTS idx_watchlist_network_enabled ON watchlist(network, enabled);

        CREATE TABLE IF NOT EXISTS ttl_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          watchlist_id INTEGER NOT NULL REFERENCES watchlist(id) ON DELETE CASCADE,
          network TEXT NOT NULL,
          current_ledger INTEGER NOT NULL,
          live_until_ledger_seq INTEGER,
          remaining_ledgers INTEGER,
          last_modified_ledger_seq INTEGER,
          status TEXT NOT NULL,
          durability TEXT NOT NULL,
          confidence TEXT NOT NULL,
          reason TEXT,
          observed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_observations_watchlist_id ON ttl_observations(watchlist_id);
        CREATE INDEX IF NOT EXISTS idx_observations_observed_at ON ttl_observations(observed_at);

        CREATE TABLE IF NOT EXISTS alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          watchlist_id INTEGER REFERENCES watchlist(id) ON DELETE SET NULL,
          network TEXT NOT NULL,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          payload_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          delivered INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_alerts_watchlist_category ON alerts(watchlist_id, category);
        CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
      `);
      this.setSchemaVersion(1);
    }

    // Migration v2: Explicit delivery status, attempts, and retention indexes
    if (currentVersion < 2) {
      this.db.exec(`
        ALTER TABLE alerts ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending';
        ALTER TABLE alerts ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE alerts ADD COLUMN last_delivery_error TEXT;
        ALTER TABLE alerts ADD COLUMN delivered_at TEXT;
        CREATE INDEX IF NOT EXISTS idx_alerts_delivery_status ON alerts(delivery_status);
      `);
      this.setSchemaVersion(2);
    }
  }

  /**
   * Watchlist operations
   */
  public addWatchlistEntry(input: CreateWatchlistInput): WatchlistRecord {
    return this.addWatchlistRecord(input);
  }

  public addWatchlistRecord(input: CreateWatchlistInput): WatchlistRecord {
    const stmt = this.db.prepare(`
      INSERT INTO watchlist (network, label, key_type, key_xdr, contract_id, warning_threshold_ledgers, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
      RETURNING id, network, label, key_type as keyType, key_xdr as keyXdr, contract_id as contractId,
                warning_threshold_ledgers as warningThresholdLedgers, enabled, created_at as createdAt, updated_at as updatedAt;
    `);

    const threshold = input.warningThresholdLedgers ?? 5000;
    const row = stmt.get(
      input.network,
      input.label,
      input.keyType,
      input.keyXdr,
      input.contractId ?? null,
      threshold,
    ) as Record<string, unknown>;

    return this.mapWatchlistRow(row);
  }

  public getWatchlistRecord(id: number): WatchlistRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, network, label, key_type as keyType, key_xdr as keyXdr, contract_id as contractId,
             warning_threshold_ledgers as warningThresholdLedgers, enabled, created_at as createdAt, updated_at as updatedAt
      FROM watchlist WHERE id = ?;
    `);
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWatchlistRow(row) : null;
  }

  public listWatchlist(
    filterOrNetwork?: string | { network?: string; enabledOnly?: boolean },
    enabledOnlyFlag: boolean = false,
  ): WatchlistRecord[] {
    let network: string | undefined;
    let enabledOnly = enabledOnlyFlag;

    if (typeof filterOrNetwork === "object" && filterOrNetwork !== null) {
      network = filterOrNetwork.network;
      if (filterOrNetwork.enabledOnly !== undefined) {
        enabledOnly = filterOrNetwork.enabledOnly;
      }
    } else if (typeof filterOrNetwork === "string") {
      network = filterOrNetwork;
    }

    let query = `
      SELECT id, network, label, key_type as keyType, key_xdr as keyXdr, contract_id as contractId,
             warning_threshold_ledgers as warningThresholdLedgers, enabled, created_at as createdAt, updated_at as updatedAt
      FROM watchlist
    `;
    const params: (string | number)[] = [];
    const conditions: string[] = [];

    if (network) {
      conditions.push("network = ?");
      params.push(network);
    }
    if (enabledOnly) {
      conditions.push("enabled = 1");
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }
    query += " ORDER BY id ASC;";

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapWatchlistRow(r));
  }

  public setWatchlistEnabled(id: number, enabled: boolean): boolean {
    const stmt = this.db.prepare(`
      UPDATE watchlist SET enabled = ?, updated_at = datetime('now') WHERE id = ?;
    `);
    const res = stmt.run(enabled ? 1 : 0, id);
    return res.changes > 0;
  }

  /**
   * TTL Observations operations
   */
  public recordObservation(input: CreateObservationInput): TTLObservationRecord {
    const stmt = this.db.prepare(`
      INSERT INTO ttl_observations (watchlist_id, network, current_ledger, live_until_ledger_seq, remaining_ledgers,
                                    last_modified_ledger_seq, status, durability, confidence, reason, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      RETURNING id, watchlist_id as watchlistId, network, current_ledger as currentLedger,
                live_until_ledger_seq as liveUntilLedgerSeq, remaining_ledgers as remainingLedgers,
                last_modified_ledger_seq as lastModifiedLedgerSeq, status, durability, confidence,
                reason, observed_at as observedAt;
    `);

    const row = stmt.get(
      input.watchlistId,
      input.network,
      input.currentLedger,
      input.liveUntilLedgerSeq ?? null,
      input.remainingLedgers ?? null,
      input.lastModifiedLedgerSeq ?? null,
      input.status,
      input.durability,
      input.confidence,
      input.reason ?? null,
    ) as Record<string, unknown>;

    return this.mapObservationRow(row);
  }

  public getRecentObservations(watchlistId: number, limit: number = 10): TTLObservationRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, watchlist_id as watchlistId, network, current_ledger as currentLedger,
             live_until_ledger_seq as liveUntilLedgerSeq, remaining_ledgers as remainingLedgers,
             last_modified_ledger_seq as lastModifiedLedgerSeq, status, durability, confidence,
             reason, observed_at as observedAt
      FROM ttl_observations
      WHERE watchlist_id = ?
      ORDER BY id DESC
      LIMIT ?;
    `);

    const rows = stmt.all(watchlistId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapObservationRow(r));
  }

  public getLatestObservation(watchlistId: number): TTLObservationRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, watchlist_id as watchlistId, network, current_ledger as currentLedger,
             live_until_ledger_seq as liveUntilLedgerSeq, remaining_ledgers as remainingLedgers,
             last_modified_ledger_seq as lastModifiedLedgerSeq, status, durability, confidence,
             reason, observed_at as observedAt
      FROM ttl_observations
      WHERE watchlist_id = ?
      ORDER BY id DESC
      LIMIT 1;
    `);

    const row = stmt.get(watchlistId) as Record<string, unknown> | undefined;
    return row ? this.mapObservationRow(row) : null;
  }

  public isAlertInCooldown(watchlistId: number, category: string, cooldownMs: number): boolean {
    return this.hasRecentAlert(watchlistId, category, cooldownMs);
  }

  public createAlert(input: {
    watchlistId: number;
    network: string;
    category: AlertCategory;
    currentLedger?: number;
    liveUntilLedgerSeq?: number;
    remainingLedgers?: number;
    thresholdLedgers?: number;
    message: string;
  }): AlertRecord {
    return this.recordAlert({
      watchlistId: input.watchlistId,
      network: input.network,
      category: input.category,
      title: `TTL Alert: ${input.category}`,
      message: input.message,
      payloadJson: JSON.stringify({
        currentLedger: input.currentLedger,
        liveUntilLedgerSeq: input.liveUntilLedgerSeq,
        remainingLedgers: input.remainingLedgers,
        thresholdLedgers: input.thresholdLedgers,
      }),
    });
  }

  /**
   * Alert operations
   */
  public recordAlert(input: CreateAlertInput): AlertRecord {
    const stmt = this.db.prepare(`
      INSERT INTO alerts (watchlist_id, network, category, title, message, payload_json, created_at, delivered, delivery_status, delivery_attempts)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0, 'pending', 0)
      RETURNING id, watchlist_id as watchlistId, network, category, title, message,
                payload_json as payloadJson, created_at as createdAt, delivered,
                delivery_status as deliveryStatus, delivery_attempts as deliveryAttempts,
                last_delivery_error as lastDeliveryError, delivered_at as deliveredAt;
    `);

    const row = stmt.get(
      input.watchlistId ?? null,
      input.network,
      input.category,
      input.title,
      input.message,
      input.payloadJson ?? null,
    ) as Record<string, unknown>;

    return this.mapAlertRow(row);
  }

  /**
   * Updates an alert's delivery outcome.
   * If status is 'delivered', sets delivered = 1 and records delivered_at timestamp.
   * If status is 'failed', increments delivery_attempts and records last_delivery_error.
   */
  public updateAlertDelivery(
    alertId: number,
    status: AlertDeliveryStatus,
    errorMessage?: string,
  ): boolean {
    const isDelivered = status === "delivered" ? 1 : 0;
    const deliveredAt = status === "delivered" ? new Date().toISOString() : null;

    const stmt = this.db.prepare(`
      UPDATE alerts
      SET delivery_status = ?,
          delivered = ?,
          delivery_attempts = delivery_attempts + 1,
          last_delivery_error = ?,
          delivered_at = COALESCE(?, delivered_at)
      WHERE id = ?;
    `);

    const res = stmt.run(status, isDelivered, errorMessage ?? null, deliveredAt, alertId);
    return res.changes > 0;
  }

  /**
   * Transactionally prunes TTL observation records older than the cutoff timestamp.
   * Never prunes watchlist entries.
   *
   * @param cutoffIso - ISO string cutoff timestamp (records strictly older will be deleted)
   * @returns Number of pruned observation records
   */
  public pruneObservations(cutoffIso: string): number {
    this.db.exec("BEGIN TRANSACTION;");
    try {
      const stmt = this.db.prepare(`
        DELETE FROM ttl_observations WHERE observed_at < ?;
      `);
      const res = stmt.run(cutoffIso);
      this.db.exec("COMMIT;");
      return Number(res.changes);
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  /**
   * Transactionally prunes historical alerts older than the cutoff timestamp.
   * STRICT SAFETY BOUNDARY:
   * Only prunes alerts that have been successfully delivered ('delivered').
   * NEVER prunes undelivered or pending alerts, regardless of age.
   * NEVER prunes watchlist records.
   *
   * @param cutoffIso - ISO string cutoff timestamp
   * @returns Number of pruned alert records
   */
  public pruneAlerts(cutoffIso: string): number {
    this.db.exec("BEGIN TRANSACTION;");
    try {
      const stmt = this.db.prepare(`
        DELETE FROM alerts
        WHERE created_at < ?
          AND (delivery_status = 'delivered' OR delivered = 1);
      `);
      const res = stmt.run(cutoffIso);
      this.db.exec("COMMIT;");
      return Number(res.changes);
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  public listAlerts(filterOrLimit: number | { watchlistId?: number } = 50): AlertRecord[] {
    let limit = 50;
    let watchlistId: number | undefined;

    if (typeof filterOrLimit === "number") {
      limit = filterOrLimit;
    } else if (filterOrLimit && typeof filterOrLimit === "object") {
      watchlistId = filterOrLimit.watchlistId;
    }

    let query = `
      SELECT id, watchlist_id as watchlistId, network, category, title, message,
             payload_json as payloadJson, created_at as createdAt, delivered,
             delivery_status as deliveryStatus, delivery_attempts as deliveryAttempts,
             last_delivery_error as lastDeliveryError, delivered_at as deliveredAt
      FROM alerts
    `;
    const params: (string | number)[] = [];
    if (watchlistId !== undefined) {
      query += ` WHERE watchlist_id = ?`;
      params.push(watchlistId);
    }
    query += ` ORDER BY id DESC LIMIT ?;`;
    params.push(limit);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapAlertRow(r));
  }

  /**
   * Cooldown check: returns true if an alert for this watchlist and category was emitted within cooldownMs.
   */
  public hasRecentAlert(watchlistId: number, category: string, cooldownMs: number): boolean {
    const cutoffIso = new Date(Date.now() - cooldownMs).toISOString();
    const stmt = this.db.prepare(`
      SELECT id FROM alerts
      WHERE watchlist_id = ? AND category = ? AND created_at >= ?
      LIMIT 1;
    `);
    const row = stmt.get(watchlistId, category, cutoffIso);
    return row !== undefined;
  }

  public close(): void {
    this.db.close();
  }

  private mapWatchlistRow(row: Record<string, unknown>): WatchlistRecord {
    return {
      id: Number(row["id"]),
      network: String(row["network"]),
      label: String(row["label"]),
      keyType: String(row["keyType"]) as WatchlistRecord["keyType"],
      keyXdr: String(row["keyXdr"]),
      contractId: row["contractId"] ? String(row["contractId"]) : null,
      warningThresholdLedgers: Number(row["warningThresholdLedgers"]),
      enabled: Boolean(row["enabled"]),
      createdAt: String(row["createdAt"]),
      updatedAt: String(row["updatedAt"]),
    };
  }

  private mapObservationRow(row: Record<string, unknown>): TTLObservationRecord {
    return {
      id: Number(row["id"]),
      watchlistId: Number(row["watchlistId"]),
      network: String(row["network"]),
      currentLedger: Number(row["currentLedger"]),
      liveUntilLedgerSeq:
        row["liveUntilLedgerSeq"] !== null ? Number(row["liveUntilLedgerSeq"]) : null,
      remainingLedgers: row["remainingLedgers"] !== null ? Number(row["remainingLedgers"]) : null,
      lastModifiedLedgerSeq:
        row["lastModifiedLedgerSeq"] !== null ? Number(row["lastModifiedLedgerSeq"]) : null,
      status: String(row["status"]),
      durability: String(row["durability"]),
      confidence: String(row["confidence"]),
      reason: row["reason"] ? String(row["reason"]) : null,
      observedAt: String(row["observedAt"]),
    };
  }

  private mapAlertRow(row: Record<string, unknown>): AlertRecord {
    return {
      id: Number(row["id"]),
      watchlistId: row["watchlistId"] !== null ? Number(row["watchlistId"]) : null,
      network: String(row["network"]),
      category: String(row["category"]) as AlertRecord["category"],
      title: String(row["title"]),
      message: String(row["message"]),
      payloadJson: row["payloadJson"] ? String(row["payloadJson"]) : null,
      createdAt: String(row["createdAt"]),
      delivered: Boolean(row["delivered"]),
      deliveryStatus: (row["deliveryStatus"] as AlertDeliveryStatus) ?? "pending",
      deliveryAttempts:
        row["deliveryAttempts"] !== null && row["deliveryAttempts"] !== undefined
          ? Number(row["deliveryAttempts"])
          : 0,
      lastDeliveryError: row["lastDeliveryError"] ? String(row["lastDeliveryError"]) : null,
      deliveredAt: row["deliveredAt"] ? String(row["deliveredAt"]) : null,
    };
  }
}
