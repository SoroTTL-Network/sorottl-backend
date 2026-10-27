import {
  type ISoroRpcClient,
  type TTLClassification,
  classifyLedgerEntry,
  evaluateThreshold,
} from "@sorottl/sdk";
import type { DatabaseClient } from "../db/client.js";
import type { Logger } from "../logging/logger.js";
import type { AlertCategory, MonitoringCycleSummary, WatchlistRecord } from "../types/domain.js";
import { reconstructLedgerKey } from "../watchlist/key-reconstructor.js";
import { mapConcurrent } from "./concurrency.js";
import { withRetry } from "./retry.js";

export interface MonitoringServiceOptions {
  readonly db: DatabaseClient;
  readonly rpcClient: ISoroRpcClient;
  readonly logger: Logger;
  readonly network: string;
  readonly alertCooldownMs?: number | undefined;
  readonly alertWebhookUrl?: string | undefined;
  /** Maximum concurrent RPC queries for ledger entries (default: 5) */
  readonly concurrency?: number | undefined;
}

/**
 * Service that executes periodic, read-only monitoring cycles over enabled watchlist entries.
 */
export class MonitoringService {
  private readonly db: DatabaseClient;
  private readonly rpcClient: ISoroRpcClient;
  private readonly logger: Logger;
  private readonly network: string;
  private readonly alertCooldownMs: number;
  private readonly alertWebhookUrl?: string | undefined;
  private readonly concurrency: number;
  private readonly activeDispatches: Set<number> = new Set();

  constructor(options: MonitoringServiceOptions) {
    this.db = options.db;
    this.rpcClient = options.rpcClient;
    this.logger = options.logger;
    this.network = options.network;
    this.alertCooldownMs = options.alertCooldownMs ?? 1800000;
    this.alertWebhookUrl = options.alertWebhookUrl;
    this.concurrency = options.concurrency ?? 5;
  }

  /**
   * Runs a single, complete monitoring cycle across all enabled watchlist entries for this network.
   */
  public async runMonitoringCycle(signal?: AbortSignal): Promise<MonitoringCycleSummary> {
    const startedAt = new Date().toISOString();
    const cycleId = `cycle_${Date.now()}`;
    const startTime = Date.now();

    this.logger.info({ cycleId, network: this.network }, "Starting monitoring cycle");

    // 1. Load enabled watchlist entries
    const watchlist = this.db.listWatchlist(this.network, true);

    if (watchlist.length === 0) {
      this.logger.info({ cycleId }, "Watchlist is empty for this network. Cycle complete.");
      const completedAt = new Date().toISOString();
      return {
        cycleId,
        network: this.network,
        startedAt,
        completedAt,
        durationMs: Date.now() - startTime,
        totalKeys: 0,
        liveKeys: 0,
        ttlReachedKeys: 0,
        unknownKeys: 0,
        errorKeys: 0,
        alertsTriggered: 0,
      };
    }

    // 2. Fetch current ledger sequence snapshot via SDK with transient retry
    let currentLedger: number;
    try {
      currentLedger = await withRetry(() => this.rpcClient.getLatestLedgerSequence(), {
        maxAttempts: 3,
        initialDelayMs: 250,
        maxDelayMs: 2000,
        maxTotalTimeoutMs: 6000,
        signal,
      });
      this.logger.debug({ cycleId, currentLedger }, "Retrieved current ledger sequence snapshot");
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        this.logger.info({ cycleId }, "Monitoring cycle cancelled by abort signal.");
        throw err;
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error({ cycleId, err }, "Failed to retrieve latest ledger from Soroban RPC");
      this.maybeTriggerAlert(null, "rpc_failure", "Soroban RPC Unreachable", errorMsg);
      const completedAt = new Date().toISOString();
      return {
        cycleId,
        network: this.network,
        startedAt,
        completedAt,
        durationMs: Date.now() - startTime,
        totalKeys: watchlist.length,
        liveKeys: 0,
        ttlReachedKeys: 0,
        unknownKeys: 0,
        errorKeys: watchlist.length,
        alertsTriggered: 1,
      };
    }

    let liveCount = 0;
    let ttlReachedCount = 0;
    let unknownCount = 0;
    let errorCount = 0;
    let alertsTriggered = 0;

    // 3. Process watchlist entries concurrently with bounded worker pool (per-key failure isolation)
    const results = await mapConcurrent(watchlist, this.concurrency, async (item) => {
      try {
        return await this.processWatchlistItem(item, currentLedger, signal);
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
          throw err;
        }

        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          { watchlistId: item.id, label: item.label, err },
          "Error processing watchlist item",
        );
        const triggered = this.maybeTriggerAlert(
          item,
          "config_failure",
          `Key Processing Failed: ${item.label}`,
          errorMsg,
        );
        return { alertsCount: triggered ? 1 : 0, isError: true, watchlistId: item.id };
      }
    });

    for (let i = 0; i < watchlist.length; i++) {
      const item = watchlist[i]!;
      const itemResult = results[i]!;
      alertsTriggered += itemResult.alertsCount;

      if (itemResult.isError) {
        errorCount++;
      } else {
        // Tally latest classification from DB
        const latestObs = this.db.getLatestObservation(item.id);
        if (latestObs?.status === "live") liveCount++;
        else if (latestObs?.status === "ttlReached") ttlReachedCount++;
        else unknownCount++;
      }
    }

    const durationMs = Date.now() - startTime;
    const completedAt = new Date().toISOString();

    const summary: MonitoringCycleSummary = {
      cycleId,
      network: this.network,
      startedAt,
      completedAt,
      durationMs,
      totalKeys: watchlist.length,
      liveKeys: liveCount,
      ttlReachedKeys: ttlReachedCount,
      unknownKeys: unknownCount,
      errorKeys: errorCount,
      alertsTriggered,
    };

    this.logger.info(summary, "Monitoring cycle completed successfully");
    return summary;
  }

  /**
   * Processes a single watchlist item against the ledger snapshot.
   */
  private async processWatchlistItem(
    item: WatchlistRecord,
    currentLedger: number,
    signal?: AbortSignal,
  ): Promise<{ alertsCount: number; isError: boolean }> {
    // 1. Reconstruct SDK xdr.LedgerKey
    const { key } = reconstructLedgerKey(item.keyType, item.keyXdr, item.contractId);

    // 2. Query ledger entry through SDK RPC client with transient retry
    let entry;
    try {
      entry = await withRetry(() => this.rpcClient.getLedgerEntry(key), {
        maxAttempts: 3,
        initialDelayMs: 200,
        maxDelayMs: 1500,
        maxTotalTimeoutMs: 5000,
        signal,
      });
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw err;
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { watchlistId: item.id, label: item.label, err },
        "RPC error querying ledger entry",
      );
      const triggered = this.maybeTriggerAlert(
        item,
        "rpc_failure",
        `RPC Query Error: ${item.label}`,
        errorMsg,
      );
      return { alertsCount: triggered ? 1 : 0, isError: true };
    }

    // 3. Classify TTL using SDK classifier
    const classification: TTLClassification = classifyLedgerEntry(entry, currentLedger);

    // 4. Persist observation
    this.db.recordObservation({
      watchlistId: item.id,
      network: this.network,
      currentLedger,
      liveUntilLedgerSeq: classification.liveUntilLedgerSeq ?? null,
      remainingLedgers: classification.remainingLedgers ?? null,
      lastModifiedLedgerSeq: classification.lastModifiedLedgerSeq ?? null,
      status: classification.status,
      durability: classification.durability,
      confidence: classification.confidence,
      reason: classification.reason ?? null,
    });

    let alertsCount = 0;

    // 5. Evaluate threshold and conditions for alerts
    if (classification.status === "ttlReached") {
      const triggered = this.maybeTriggerAlert(
        item,
        "ttl_reached",
        `TTL Boundary Reached: ${item.label}`,
        `Ledger entry for ${item.label} has reached or passed its TTL boundary at current ledger ${currentLedger} (liveUntil: ${classification.liveUntilLedgerSeq}). Note: entry may be archived or permanently expired.`,
      );
      if (triggered) alertsCount++;
    } else if (classification.status === "live") {
      const risk = evaluateThreshold(classification, {
        warningThresholdLedgers: item.warningThresholdLedgers,
      });

      if (risk.needsAttention) {
        const triggered = this.maybeTriggerAlert(
          item,
          "low_ttl",
          `Low TTL Warning: ${item.label}`,
          `Entry ${item.label} is live with ${classification.remainingLedgers} remaining ledgers, which is below the warning threshold of ${item.warningThresholdLedgers}.`,
        );
        if (triggered) alertsCount++;
      }
    } else if (classification.status === "unknown") {
      // Entry missing from RPC or uninitialized
      const triggered = this.maybeTriggerAlert(
        item,
        "unknown_status",
        `TTL Status Unknown: ${item.label}`,
        `Entry ${item.label} was not found on the ledger or TTL metadata is unavailable. (Does not prove archival status)`,
      );
      if (triggered) alertsCount++;
    }

    return { alertsCount, isError: false };
  }

  /**
   * Helper that records an alert if not currently in cooldown.
   */
  private maybeTriggerAlert(
    item: WatchlistRecord | null,
    category: AlertCategory,
    title: string,
    message: string,
  ): boolean {
    const watchlistId = item?.id ?? -1;

    // Check cooldown
    if (watchlistId > 0 && this.db.hasRecentAlert(watchlistId, category, this.alertCooldownMs)) {
      this.logger.debug({ watchlistId, category }, "Alert suppressed by cooldown window");
      return false;
    }

    this.logger.warn({ watchlistId, category, title }, "Triggering alert");

    const alertRecord = this.db.recordAlert({
      watchlistId: item?.id ?? null,
      network: this.network,
      category,
      title,
      message,
      payloadJson: JSON.stringify({
        watchlistId: item?.id ?? null,
        label: item?.label ?? "system",
        keyXdr: item?.keyXdr ?? null,
      }),
    });

    // Optional external webhook dispatch with explicit delivery tracking
    if (this.alertWebhookUrl) {
      this.dispatchWebhook(alertRecord.id, title, message).catch((err) => {
        this.logger.error({ alertId: alertRecord.id, err }, "Failed to dispatch alert webhook");
      });
    }

    return true;
  }

  /**
   * Reconciles eligible pending alerts left from previous crashed or aborted cycles.
   * Runs bounded delivery without blocking regular monitoring cycles indefinitely.
   *
   * @param limit - Max pending alerts to reconcile in one pass (default: 25)
   * @returns Number of successfully reconciled alerts
   */
  public async reconcilePendingAlerts(limit: number = 25): Promise<number> {
    if (!this.alertWebhookUrl) return 0;

    let pendingAlerts;
    try {
      pendingAlerts = this.db.getEligiblePendingAlerts(limit);
    } catch (err) {
      this.logger.error({ err }, "Failed to query eligible pending alerts for reconciliation");
      return 0;
    }

    if (pendingAlerts.length === 0) return 0;

    this.logger.info(
      { count: pendingAlerts.length },
      "Starting pending alert webhook reconciliation",
    );

    let deliveredCount = 0;
    for (const alert of pendingAlerts) {
      try {
        const delivered = await this.dispatchWebhook(alert.id, alert.title, alert.message);
        if (delivered) deliveredCount++;
      } catch (err) {
        this.logger.error({ alertId: alert.id, err }, "Unexpected error reconciling pending alert");
      }
    }

    this.logger.info(
      { deliveredCount, totalReconciled: pendingAlerts.length },
      "Pending alert reconciliation finished",
    );

    return deliveredCount;
  }

  /**
   * Dispatches alert payload to configured webhook endpoint with bounded retries,
   * timeout (5000ms), and updates SQLite delivery status.
   * Uses alertId in payload as stable idempotency key.
   * Prevents concurrent dispatch of the same alertId within one process.
   */
  public async dispatchWebhook(
    alertId: number,
    title: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.alertWebhookUrl) return false;

    // Prevent duplicate concurrent dispatch of the same alert
    if (this.activeDispatches.has(alertId)) {
      this.logger.warn(
        { alertId },
        "Webhook dispatch already active for alert. Skipping concurrent duplicate.",
      );
      return false;
    }

    this.activeDispatches.add(alertId);

    const payload = JSON.stringify({
      network: this.network,
      alertId,
      title,
      message,
      timestamp: new Date().toISOString(),
    });

    try {
      await withRetry(
        async () => {
          const response = await fetch(this.alertWebhookUrl!, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Idempotency-Key": `sorottl-alert-${alertId}`,
            },
            body: payload,
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
              : AbortSignal.timeout(5000),
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }
          return response;
        },
        {
          maxAttempts: 3,
          initialDelayMs: 300,
          maxDelayMs: 2000,
          maxTotalTimeoutMs: 6000,
          signal,
        },
      );

      // Record successful delivery
      try {
        this.db.updateAlertDelivery(alertId, "delivered");
      } catch (dbErr) {
        this.logger.error({ alertId, dbErr }, "Database error recording delivered alert status");
        throw dbErr;
      }

      this.logger.debug({ alertId }, "Webhook delivered successfully");
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      try {
        this.db.updateAlertDelivery(alertId, "failed", errorMsg);
      } catch (dbErr) {
        this.logger.error({ alertId, dbErr }, "Database error recording failed alert status");
      }
      this.logger.warn({ alertId, errorMsg }, "Webhook delivery failed after retries");
      return false;
    } finally {
      this.activeDispatches.delete(alertId);
    }
  }
}
