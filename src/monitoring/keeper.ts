import type { Logger } from "../logging/logger.js";
import type { MonitoringService } from "./monitoring-service.js";

export interface KeeperOptions {
  readonly monitoringService: MonitoringService;
  readonly logger: Logger;
  readonly intervalMs: number;
}

/**
 * Keeper daemon managing non-overlapping periodic monitoring cycles and graceful shutdown.
 */
export class KeeperDaemon {
  private readonly monitoringService: MonitoringService;
  private readonly logger: Logger;
  private readonly intervalMs: number;

  private _isRunning: boolean = false;
  private isCycleInProgress: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private abortController: AbortController | null = null;

  constructor(options: KeeperOptions) {
    this.monitoringService = options.monitoringService;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs;
  }

  /**
   * Starts the keeper periodic monitoring loop.
   */
  public start(): void {
    if (this._isRunning) {
      this.logger.warn("Keeper is already running.");
      return;
    }

    this._isRunning = true;
    this.abortController = new AbortController();

    this.logger.info(
      { intervalMs: this.intervalMs },
      "Keeper daemon started. Initiating periodic monitoring loop.",
    );

    // Run first cycle immediately
    void this.runCycle();

    // Schedule periodic loop
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.intervalMs);
  }

  /**
   * Gracefully shuts down the keeper daemon.
   */
  public async stop(): Promise<void> {
    if (!this._isRunning) {
      return;
    }

    this.logger.info("Graceful shutdown signal received. Stopping keeper daemon...");
    this._isRunning = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // If a cycle is in progress, wait for it to finish
    let waitCount = 0;
    while (this.isCycleInProgress && waitCount < 10) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      waitCount++;
    }

    this.logger.info("Keeper daemon stopped cleanly.");
  }

  /**
   * Runs a single cycle with mutex protection against overlapping runs.
   */
  public async runCycle(): Promise<void> {
    if (!this._isRunning && this.timer) {
      return;
    }

    if (this.isCycleInProgress) {
      this.logger.warn("Previous monitoring cycle is still in progress. Skipping overlapping run.");
      return;
    }

    this.isCycleInProgress = true;
    try {
      await this.monitoringService.runMonitoringCycle();
    } catch (err) {
      // The keeper must not crash or silently die from transient errors
      this.logger.error({ err }, "Unhandled error during keeper monitoring cycle");
    } finally {
      this.isCycleInProgress = false;
    }
  }

  public isRunning(): boolean {
    return this._isRunning;
  }
}
