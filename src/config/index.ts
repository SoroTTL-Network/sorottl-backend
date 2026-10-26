import { z } from "zod";

/**
 * Zod schema defining backend and keeper configuration.
 */
export const AppConfigSchema = z.object({
  /** Stellar network: 'testnet' or 'mainnet' (never silently falls back) */
  network: z.enum(["testnet", "mainnet"]),
  /** Soroban RPC URL override */
  rpcUrl: z.string().url(),
  /** SQLite database file path */
  dbPath: z.string().min(1).default("./sorottl.db"),
  /** Logging verbosity */
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Periodic monitoring interval in milliseconds (default 30s) */
  monitoringIntervalMs: z.coerce.number().int().positive().default(30000),
  /** Default warning threshold in ledgers (e.g. 10000 ledgers) */
  defaultWarningThresholdLedgers: z.coerce.number().int().nonnegative().default(10000),
  /** Alert suppression cooldown window in milliseconds (default 30 minutes) */
  alertCooldownMs: z.coerce.number().int().nonnegative().default(1800000),
  /** Optional webhook endpoint for external notification dispatch */
  alertWebhookUrl: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * Loads configuration from process environment variables and optional overrides.
 * Strictly validates network and settings without falling back.
 */
export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  const envConfig = {
    network: (process.env["SOROTTL_NETWORK"] || "testnet") as "testnet" | "mainnet",
    rpcUrl:
      process.env["SOROTTL_RPC_URL"] ||
      (process.env["SOROTTL_NETWORK"] === "mainnet"
        ? "https://mainnet.sorobanrpc.com"
        : "https://soroban-testnet.stellar.org"),
    dbPath: process.env["SOROTTL_DB_PATH"] || "./sorottl.db",
    logLevel: (process.env["SOROTTL_LOG_LEVEL"] || "info") as AppConfig["logLevel"],
    monitoringIntervalMs: process.env["SOROTTL_MONITORING_INTERVAL_MS"]
      ? Number(process.env["SOROTTL_MONITORING_INTERVAL_MS"])
      : 30000,
    defaultWarningThresholdLedgers: process.env["SOROTTL_DEFAULT_WARNING_THRESHOLD_LEDGERS"]
      ? Number(process.env["SOROTTL_DEFAULT_WARNING_THRESHOLD_LEDGERS"])
      : process.env["SOROTTL_WARNING_THRESHOLD_LEDGERS"]
        ? Number(process.env["SOROTTL_WARNING_THRESHOLD_LEDGERS"])
        : 10000,
    alertCooldownMs: process.env["SOROTTL_ALERT_COOLDOWN_MS"]
      ? Number(process.env["SOROTTL_ALERT_COOLDOWN_MS"])
      : 1800000,
    alertWebhookUrl: process.env["SOROTTL_ALERT_WEBHOOK_URL"] || undefined,
  };

  const merged = { ...envConfig, ...(overrides ?? {}) };

  const parsed = AppConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const errorMessages = parsed.error.issues
      .map((i) => `Field '${i.path.join(".")}': ${i.message}`)
      .join("; ");
    throw new Error(`Invalid SoroTTL configuration: ${errorMessages}`);
  }

  return parsed.data;
}
