import { SoroRpcClient, getNetworkConfig } from "@sorottl/sdk";
import { Command } from "commander";
import { type AppConfig, loadConfig } from "../config/index.js";
import { DatabaseClient } from "../db/client.js";
import { createLogger } from "../logging/logger.js";
import { KeeperDaemon } from "../monitoring/keeper.js";
import { MonitoringService } from "../monitoring/monitoring-service.js";
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
      const { config, logger, monitoringService } = initContext();
      const keeper = new KeeperDaemon({
        monitoringService,
        logger,
        intervalMs: config.monitoringIntervalMs,
      });

      keeper.start();

      const shutdown = async () => {
        console.log("\nShutdown signal caught. Stopping keeper...");
        await keeper.stop();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
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
          console.log(`[${a.createdAt}] [${a.category.toUpperCase()}] ${a.title}`);
          console.log(`  ${a.message}`);
        }
        db.close();
        process.exitCode = 0;
      } catch (err) {
        console.error(`[Error]: ${err instanceof Error ? err.message : String(err)}`);
        db.close();
        process.exitCode = 1;
      }
    });

  return program;
}
