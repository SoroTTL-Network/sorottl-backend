import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config/index.js";

describe("Configuration Loader & Render Compatibility", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads valid default configuration for testnet", () => {
    delete process.env.SOROTTL_NETWORK;
    delete process.env.SOROTTL_RPC_URL;
    delete process.env.SOROTTL_DB_PATH;
    delete process.env.PORT;
    delete process.env.SOROTTL_API_PORT;
    delete process.env.SOROTTL_API_HOST;

    const config = loadConfig();
    expect(config.network).toBe("testnet");
    expect(config.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(config.dbPath).toBe("./sorottl.db");
    expect(config.apiPort).toBe(8080);
    expect(config.apiHost).toBe("127.0.0.1");
    expect(config.monitoringIntervalMs).toBe(30000);
    expect(config.alertCooldownMs).toBe(1800000);
    expect(config.defaultWarningThresholdLedgers).toBe(10000);
    expect(config.logLevel).toBe("info");
  });

  it("prioritizes Render's dynamic PORT environment variable", () => {
    delete process.env.SOROTTL_API_PORT;
    process.env.PORT = "10000";
    process.env.SOROTTL_API_HOST = "0.0.0.0";

    const config = loadConfig();
    expect(config.apiPort).toBe(10000);
    expect(config.apiHost).toBe("0.0.0.0");
  });

  it("allows SOROTTL_API_PORT to override port when PORT is unset", () => {
    delete process.env.PORT;
    process.env.SOROTTL_API_PORT = "9090";

    const config = loadConfig();
    expect(config.apiPort).toBe(9090);
  });

  it("forbids ephemeral in-memory SQLite in production", () => {
    process.env.NODE_ENV = "production";
    process.env.SOROTTL_DB_PATH = ":memory:";

    expect(() => loadConfig()).toThrow("In-memory SQLite (:memory:) is forbidden in production");
  });

  it("accepts persistent disk path in production", () => {
    process.env.NODE_ENV = "production";
    process.env.SOROTTL_DB_PATH = "/var/data/sorottl.db";

    const config = loadConfig();
    expect(config.nodeEnv).toBe("production");
    expect(config.dbPath).toBe("/var/data/sorottl.db");
  });

  it("loads mainnet configuration with explicit overrides", () => {
    process.env.SOROTTL_NETWORK = "mainnet";
    process.env.SOROTTL_RPC_URL = "https://mainnet.sorobanrpc.com";
    process.env.SOROTTL_DB_PATH = "/tmp/test.db";
    process.env.SOROTTL_MONITORING_INTERVAL_MS = "60000";
    process.env.SOROTTL_ALERT_COOLDOWN_MS = "3600000";
    process.env.SOROTTL_DEFAULT_WARNING_THRESHOLD_LEDGERS = "25000";
    process.env.SOROTTL_ALERT_WEBHOOK_URL = "https://hooks.slack.com/services/test";
    process.env.SOROTTL_LOG_LEVEL = "debug";

    const config = loadConfig();
    expect(config.network).toBe("mainnet");
    expect(config.rpcUrl).toBe("https://mainnet.sorobanrpc.com");
    expect(config.dbPath).toBe("/tmp/test.db");
    expect(config.monitoringIntervalMs).toBe(60000);
    expect(config.alertCooldownMs).toBe(3600000);
    expect(config.defaultWarningThresholdLedgers).toBe(25000);
    expect(config.alertWebhookUrl).toBe("https://hooks.slack.com/services/test");
    expect(config.logLevel).toBe("debug");
  });

  it("rejects unsupported network names", () => {
    process.env.SOROTTL_NETWORK = "futurenet";
    expect(() => loadConfig()).toThrow();
  });

  it("rejects invalid RPC URLs", () => {
    process.env.SOROTTL_RPC_URL = "not-a-url";
    expect(() => loadConfig()).toThrow();
  });

  it("rejects non-positive interval values", () => {
    process.env.SOROTTL_MONITORING_INTERVAL_MS = "0";
    expect(() => loadConfig()).toThrow();
  });
});
