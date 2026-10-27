import { SoroRpcClient, getNetworkConfig } from "@sorottl/sdk";
import { Command } from "commander";
import { type AppConfig, loadConfig } from "../config/index.js";
import { DatabaseClient } from "../db/client.js";
import { createLogger } from "../logging/logger.js";
import { KeeperDaemon } from "../monitoring/keeper.js";
import { MonitoringService } from "../monitoring/monitoring-service.js";
import { HttpServer } from "../server/index.js";
import { reconstructLedgerKey } from "../watchlist/key-reconstructor.js";

/**
 * Creates and configures the CLI command program.
 */
export function createCli(overrides?: Partial<AppConfig>): Command {
  return createProgram(overrides);
}

export function createProgram(overrides?: Partial<AppConfig>): Command {
  const program = new Command();

  program
    .name("sorottl")
    .description("SoroTTL Keeper CLI - Inspect and monitor Stellar Soroban state TTL lifecycles")
    .version("0.1.0");

  // Helper to initialize context
  function initContext() {
    const config = loadConfig(overrides);
    const logger = createLogger(config.logLevel);
    const db = new DatabaseClient(config.dbPath);
    const networkConfig = getNetworkConfig(config.network, {
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    });
    const rpcClient = new SoroRpcClient({ rpcUrl: networkConfig.rpcUrl });
    const monitoringService = new MonitoringService({
      db,
      rpcClient,
      logger,
      network: config.network,
      alertCooldownMs: config.alertCooldownMs,
      alertWebhookUrl: config.alertWebhookUrl,
    });

    return { config, logger, db, rpcClient, monitoringService, networkConfig };
  }

  // 1. config:check
  program
    .command("config:check")
    .description("Validate backend configuration and check connectivity to Stellar Soroban RPC")
    .action(async () => {
      try {
        const { config, rpcClient, db } = initContext();
        console.log(`[Config Check] Network: ${config.network}`);
        console.log(`[Config Check] Database: ${config.dbPath}`);

        const latestSeq = await rpcClient.getLatestLedgerSequence();
        console.log(`[RPC Check] Connected successfully. Latest ledger sequence: ${latestSeq}`);
        db.close();
        process.exitCode = 0;
      } catch (err) {
        console.error(`[Config Check Failed]: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // 2. watchlist:add
  program
    .command("watchlist:add")
    .description(
      "Add a contract instance, Wasm code, or contract data key to the monitoring watchlist",
    )
    .requiredOption("-t, --type <type>", "Key type ('instance', 'contractCode', 'contractData')")
    .requiredOption("-l, --label <label>", "Descriptive label for this key")
    .option("-c, --contract-id <contractId>", "Contract ID ('C...') for instance keys")
    .option("-x, --key-xdr <keyXdr>", "Canonical base64 LedgerKey XDR or 64-char hex Wasm hash")
    .option("-w, --warning-threshold <threshold>", "Warning threshold in ledger units", "5000")
    .action((opts) => {
      const { config, db } = initContext();
      try {
        const keyType = opts.type;
        if (keyType !== "instance" && keyType !== "contractCode" && keyType !== "contractData") {
          throw new Error("Invalid --type. Must be 'instance', 'contractCode', or 'contractData'.");
        }

        const keyXdrInput =
          opts.keyXdr || (keyType === "instance" && opts.contractId ? opts.contractId : "");
        if (!keyXdrInput) {
          throw new Error("Must provide --key-xdr or --contract-id.");
        }

        // Reconstruct and validate key
        const reconstructed = reconstructLedgerKey(keyType, keyXdrInput, opts.contractId);

        const record = db.addWatchlistRecord({
          network: config.network,
          label: opts.label,
          keyType,
          keyXdr: reconstructed.keyXdr,
          contractId: opts.contractId ?? null,
          warningThresholdLedgers: Number(opts.warningThreshold),
        });

        console.log(
          `[Watchlist Added] ID: ${record.id} | Label: ${record.label} | Network: ${record.network}`,
        );
        db.close();
        process.exitCode = 0;
      } catch (err) {
        console.error(`[Watchlist Error]: ${err instanceof Error ? err.message : String(err)}`);
        db.close();
        process.exitCode = 1;
      }
    });

  // 3. watchlist:list
  program
    .command("watchlist:list")
    .description("List all monitored keys in the watchlist")
    .action(() => {
      const { config, db } = initContext();
      try {
        const list = db.listWatchlist(config.network);
        console.log(`--- SoroTTL Watchlist (${config.network}) [${list.length} items] ---`);
        for (const item of list) {
          const obs = db.getLatestObservation(item.id);
          const status = obs
            ? `${obs.status} (remaining: ${obs.remainingLedgers ?? "N/A"})`
            : "unobserved";
          console.log(
            `#${item.id} [${item.enabled ? "ENABLED" : "DISABLED"}] ${item.label} (${item.keyType}) -> Status: ${status}`,
          );
        }
        db.close();
        process.exitCode = 0;
      } catch (err) {
        console.error(`[Error]: ${err instanceof Error ? err.message : String(err)}`);
        db.close();
        process.exitCode = 1;
      }
    });

  // 4. watchlist:disable
  program
    .command("watchlist:disable <id>")
    .description("Disable monitoring for a watchlist record by ID")
    .action((idStr) => {
      const { db } = initContext();
      try {
        const id = Number(idStr);
        const updated = db.setWatchlistEnabled(id, false);
        if (updated) {
          console.log(`[Watchlist Disabled] Item #${id} has been disabled.`);
        } else {
          console.error(`[Error] Watchlist item #${id} not found.`);
          process.exitCode = 1;
        }
        db.close();
      } catch (err) {
        console.error(`[Error]: ${err instanceof Error ? err.message : String(err)}`);
        db.close();
        process.exitCode = 1;
      }
    });

  // 5. monitor:once
  program
    .command("monitor:once")
    .description("Perform a single, immediate read-only monitoring cycle and persist observations")
    .action(async () => {
      const { monitoringService, db } = initContext();
      try {
        const summary = await monitoringService.runMonitoringCycle();
        console.log("--- Monitoring Cycle Complete ---");
        console.log(`Total Keys: ${summary.totalKeys}`);
        console.log(
          `Live: ${summary.liveKeys} | TTL Reached: ${summary.ttlReachedKeys} | Unknown: ${summary.unknownKeys}`,
        );
        console.log(`Alerts Triggered: ${summary.alertsTriggered}`);
        db.close();
        process.exitCode = 0;
      } catch (err) {
        console.error(`[Monitor Error]: ${err instanceof Error ? err.message : String(err)}`);
        db.close();
        process.exitCode = 1;
      }
    });

  // 6. keeper:start
  program
    .command("keeper:start")
    .description("Start the long-running keeper monitoring daemon")
    .action(async () => {
      const { config, logger, monitoringService, db, rpcClient } = initContext();
      const keeper = new KeeperDaemon({
        monitoringService,
        logger,
        intervalMs: config.monitoringIntervalMs,
      });

      const server = new HttpServer({
        db,
        rpcClient,
        logger,
        port: config.apiPort,
        host: config.apiHost,
        network: config.network,
        authToken: config.apiAuthToken,
        corsOrigin: config.apiCorsOrigin,
        isKeeperRunning: () => keeper.isRunning(),
      });

      keeper.start();
      void server.start().catch((err) => {
        logger.error({ err }, "Failed to start HTTP API alongside keeper");
      });

      let isShuttingDown = false;
      const shutdown = async (signal: string) => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        logger.info({ signal }, "Shutdown signal received. Performing graceful keeper cleanup...");
        try {
          await Promise.allSettled([keeper.stop(), server.stop()]);
          db.close();
          logger.info("Keeper resources closed cleanly.");
          process.exit(0);
        } catch (err) {
          logger.error({ err }, "Error during keeper shutdown");
          db.close();
          process.exit(1);
        }
      };

      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));

      // Process fatal exception handlers
      process.on("uncaughtException", (err: Error) => {
        logger.fatal(
          { err: { message: err.message, stack: err.stack } },
          "Uncaught exception in keeper process. Halting.",
        );
        try {
          void Promise.allSettled([keeper.stop(), server.stop().catch(() => {})]).finally(() => {
            db.close();
            process.exit(1);
          });
        } catch {
          process.exit(1);
        }
      });

      process.on("unhandledRejection", (reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        logger.error({ reason: message }, "Unhandled promise rejection in keeper process");
      });
    });

  // 7. alerts:list
  program
    .command("alerts:list")
    .description("List recent alerts generated by the keeper")
    .option("-n, --limit <limit>", "Maximum number of alerts to display", "20")
    .action((opts) => {
      const { db } = initContext();
      try {
        const alerts = db.listAlerts(Number(opts.limit));
        console.log(`--- Recent Alerts (${alerts.length}) ---`);
        for (const a of alerts) {
          const status = a.deliveryStatus
            ? `[${a.deliveryStatus.toUpperCase()}]`
            : a.delivered
              ? "[DELIVERED]"
              : "[PENDING]";
          console.log(`[${a.createdAt}] [${a.category.toUpperCase()}] ${status} ${a.title}`);
          console.log(`  ${a.message}`);
          if (a.lastDeliveryError) {
            console.log(`  Last Delivery Error: ${a.lastDeliveryError}`);
          }
        }
        db.close();
        process.exitCode = 0;
      } catch (err) {
        console.error(`[Error]: ${err instanceof Error ? err.message : String(err)}`);
        db.close();
        process.exitCode = 1;
      }
    });

  // 8. db:prune
  program
    .command("db:prune")
    .description(
      "Prune historical observations and delivered alerts older than the specified retention window",
    )
    .option("--observations-days <days>", "Retention days for TTL observations", "14")
    .option(
      "--alerts-days <days>",
      "Retention days for delivered alerts (undelivered alerts are never pruned)",
      "30",
    )
    .action((opts) => {
      const { db } = initContext();
      try {
        const obsDays = Number(opts.observationsDays);
        const alertDays = Number(opts.alertsDays);

        const obsCutoff = new Date(Date.now() - obsDays * 86400000).toISOString();
        const alertCutoff = new Date(Date.now() - alertDays * 86400000).toISOString();

        const prunedObs = db.pruneObservations(obsCutoff);
        const prunedAlerts = db.pruneAlerts(alertCutoff);

        console.log(`[Retention Pruning Complete]`);
        console.log(`  Observations pruned (older than ${obsDays}d): ${prunedObs}`);
        console.log(`  Delivered alerts pruned (older than ${alertDays}d): ${prunedAlerts}`);
        db.close();
        process.exitCode = 0;
      } catch (err) {
        console.error(`[Prune Error]: ${err instanceof Error ? err.message : String(err)}`);
        db.close();
        process.exitCode = 1;
      }
    });

  // 9. server:start
  program
    .command("server:start")
    .description("Start the standalone read-only HTTP API server for SoroTTL inspection")
    .option("-p, --port <port>", "Port to bind HTTP server to")
    .option("-h, --host <host>", "Host address to bind HTTP server to")
    .action(async (opts) => {
      const { config, logger, db, rpcClient } = initContext();
      const port = opts.port ? Number(opts.port) : config.apiPort;
      const host = opts.host || config.apiHost;

      const server = new HttpServer({
        db,
        rpcClient,
        logger,
        port,
        host,
        network: config.network,
        authToken: config.apiAuthToken,
        corsOrigin: config.apiCorsOrigin,
      });

      try {
        const bound = await server.start();
        console.log(
          `[HTTP API Ready] Listening on http://${bound.host}:${bound.port} (network: ${config.network})`,
        );

        let isShuttingDown = false;
        const shutdown = async (signal: string) => {
          if (isShuttingDown) return;
          isShuttingDown = true;
          logger.info({ signal }, "Shutting down HTTP API server...");
          try {
            await server.stop();
            db.close();
            process.exit(0);
          } catch (err) {
            logger.error({ err }, "Error during server shutdown");
            db.close();
            process.exit(1);
          }
        };

        process.on("SIGINT", () => void shutdown("SIGINT"));
        process.on("SIGTERM", () => void shutdown("SIGTERM"));
      } catch (err) {
        console.error(`[Server Start Error]: ${err instanceof Error ? err.message : String(err)}`);
        db.close();
        process.exit(1);
      }
    });

  return program;
}
