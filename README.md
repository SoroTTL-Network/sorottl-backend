# SoroTTL Backend — Keeper Foundation & TTL Monitoring

[![CI](https://github.com/SoroTTL-Network/sorottl-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/SoroTTL-Network/sorottl-backend/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Autonomous, non-custodial keeper service and CLI toolkit for monitoring Stellar Soroban smart contract state TTL lifecycles.

> [!IMPORTANT]
> **Strict Safety Boundary:**
> SoroTTL Backend operates strictly as a **read-only observer**. It reconstructs ledger keys, inspects TTL metadata via Stellar RPC, and records observations and alerts. It **never requests, accepts, or stores private keys, seeds, or credentials**, and **never signs or submits transactions to the Stellar network**.

---

## Features

- **Automated Watchlist Tracking**: Reconstruct and monitor `instance`, `contractCode`, and `contractData` keys deterministically via `@sorottl/sdk`.
- **Pure Soroban TTL Classification**: Utilizes the SDK classifier and Protocol 23 boundary semantics directly (no duplicate formulas or synthetic heuristics).
- **Embedded Persistence**: Zero-dependency SQLite engine (using Node.js `node:sqlite` `DatabaseSync`) with WAL mode, transactions, and foreign key enforcement.
- **Alert Suppression & Deduplication**: Configurable per-key alert cooldown windows and optional webhook alerts (Slack, Discord, PagerDuty, or custom endpoints).
- **Keeper Daemon Lifecycle**: Non-overlapping periodic loop, concurrent run mutex, and graceful shutdown on `SIGINT` / `SIGTERM`.
- **Comprehensive CLI**: Inspect configuration, add/list/disable watchlist entries, run one-off monitoring cycles, or spawn the keeper daemon.
- **Containerized**: Production-ready, non-root multi-stage Docker build with volume mounts for persistent database storage.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/SoroTTL-Network/sorottl-backend.git
cd sorottl-backend

# Install dependencies (requires Node.js >= 22.0.0)
npm install

# Build CLI and daemon
npm run build
```

---

## Configuration

Configuration is loaded from environment variables with strict validation. Invalid configurations or unsupported networks halt startup immediately without silent fallbacks.

| Variable                                    | Description                                        | Default         |
| :------------------------------------------ | :------------------------------------------------- | :-------------- |
| `SOROTTL_NETWORK`                           | Stellar network (`testnet` or `mainnet`)           | `testnet`       |
| `SOROTTL_RPC_URL`                           | Custom Soroban RPC endpoint override               | Network default |
| `SOROTTL_DB_PATH`                           | Path to SQLite database file                       | `./sorottl.db`  |
| `SOROTTL_MONITORING_INTERVAL_MS`            | Keeper loop frequency in milliseconds              | `30000` (30s)   |
| `SOROTTL_DEFAULT_WARNING_THRESHOLD_LEDGERS` | Default threshold for low TTL warnings             | `10000` ledgers |
| `SOROTTL_ALERT_COOLDOWN_MS`                 | Cooldown window before repeating an alert          | `1800000` (30m) |
| `SOROTTL_ALERT_WEBHOOK_URL`                 | Webhook URL for external alert notifications       | `undefined`     |
| `SOROTTL_LOG_LEVEL`                         | Pino logging level (`info`, `debug`, `warn`, etc.) | `info`          |

---

## CLI Usage

The CLI executable is available via `sorottl` (or `node dist/cli/index.js`):

```bash
# Verify configuration and RPC connectivity
npm run cli -- config:check

# Add a contract instance to the watchlist
npm run cli -- watchlist:add --type instance --contract CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC --label "Governance Instance" --threshold 15000

# Add a Wasm code hash to the watchlist
npm run cli -- watchlist:add --type contractCode --wasm-hash 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --label "Core Wasm"

# List all monitored entries
npm run cli -- watchlist:list

# Run a single immediate read-only monitoring cycle
npm run cli -- monitor:once

# Start the continuous keeper daemon
npm run cli -- keeper:start

# List recent generated alerts
npm run cli -- alerts:list --limit 20
```

---

## Running with Docker

Mount a host directory to `/data` to persist the SQLite database:

```bash
# Build the container
docker build -t sorottl-backend:latest .

# Run the keeper daemon
docker run -d \
  --name sorottl-keeper \
  -e SOROTTL_NETWORK=testnet \
  -e SOROTTL_MONITORING_INTERVAL_MS=30000 \
  -v $(pwd)/data:/data \
  sorottl-backend:latest
```

---

## Safety & Security

- **Strictly Non-Custodial**: Does not handle private keys, keystores, or seeds.
- **Redacting Logger**: The built-in logger automatically redacts sensitive keywords (`secret`, `privateKey`, `seedPhrase`, `password`, `token`) in all log streams.
- **RPC Isolation**: Per-key errors are safely caught and recorded without terminating the monitoring daemon or corrupting consecutive keys.

---

## License

Apache-2.0
