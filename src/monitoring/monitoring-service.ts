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

export interface MonitoringServiceOptions {
  readonly db: DatabaseClient;
  readonly rpcClient: ISoroRpcClient;
  readonly logger: Logger;
  readonly network: string;
  readonly alertCooldownMs?: number | undefined;
  readonly alertWebhookUrl?: string | undefined;
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

  constructor(options: MonitoringServiceOptions) {
    this.db = options.db;
    this.rpcClient = options.rpcClient;
    this.logger = options.logger;
    this.network = options.network;
    this.alertCooldownMs = options.alertCooldownMs ?? 1800000;
    this.alertWebhookUrl = options.alertWebhookUrl;
  }

  /**
   * Runs a single, complete monitoring cycle across all enabled watchlist entries for this network.
   */
  public async runMonitoringCycle(): Promise<MonitoringCycleSummary> {
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

    // 2. Fetch current ledger sequence snapshot via SDK
    let currentLedger: number;
    try {
      currentLedger = await this.rpcClient.getLatestLedgerSequence();
      this.logger.debug({ cycleId, currentLedger }, "Retrieved current ledger sequence snapshot");
    } catch (err) {
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

    // 3. Process each watchlist entry independently (per-key failure isolation)
    for (const item of watchlist) {
      try {
        const itemResult = await this.processWatchlistItem(item, currentLedger);
        alertsTriggered += itemResult.alertsCount;

        if (itemResult.isError) {
          errorCount++;
        } else {
          // Tally latest classification
          const latestObs = this.db.getLatestObservation(item.id);
          if (latestObs?.status === "live") liveCount++;
          else if (latestObs?.status === "ttlReached") ttlReachedCount++;
          else unknownCount++;
        }
      } catch (err) {
        errorCount++;
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
        if (triggered) alertsTriggered++;
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
  ): Promise<{ alertsCount: number; isError: boolean }> {
    // 1. Reconstruct SDK xdr.LedgerKey
    const { key } = reconstructLedgerKey(item.keyType, item.keyXdr, item.contractId);

    // 2. Query ledger entry through SDK RPC client
    let entry;
    try {
      entry = await this.rpcClient.getLedgerEntry(key);
    } catch (err) {
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

    this.db.recordAlert({
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

    // Optional external webhook dispatch
    if (this.alertWebhookUrl) {
      this.dispatchWebhook(title, message).catch((err) => {
        this.logger.error({ err }, "Failed to dispatch alert webhook");
      });
    }

    return true;
  }

  private async dispatchWebhook(title: string, message: string): Promise<void> {
    if (!this.alertWebhookUrl) return;
    try {
      await fetch(this.alertWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: this.network,
          title,
          message,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (err) {
      this.logger.error({ err }, "Webhook fetch failure");
    }
  }
}
