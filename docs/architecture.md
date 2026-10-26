# SoroTTL Keeper Lifecycle & Architecture

## Overview

The SoroTTL Keeper is an autonomous, read-only daemon designed to monitor Stellar Soroban state TTL lifecycles across contract instances, Wasm bytecode entries, and contract data.

```
+-----------------------------------------------------------+
|                       Keeper Daemon                       |
|                                                           |
|  +-------------------+              +------------------+  |
|  | Periodic Schedule |  --------->  |  Non-Overlap     |  |
|  | (Configurable ms) |              |  Run Mutex       |  |
|  +-------------------+              +------------------+  |
|                                              |            |
|                                              v            |
|  +-----------------------------------------------------+  |
|  |                 Monitoring Service                  |  |
|  |                                                     |  |
|  | 1. Fetch enabled watchlist from SQLite              |  |
|  | 2. Snapshot current ledger via @sorottl/sdk RPC     |  |
|  | 3. Reconstruct canonical XDR keys                   |  |
|  | 4. Query entry TTL metadata via getLedgerEntry      |  |
|  | 5. Classify TTL state via SDK TTLClassifier         |  |
|  | 6. Persist observation records                      |  |
|  | 7. Evaluate warning thresholds                      |  |
|  | 8. Deduplicate alerts via Cooldown Window           |  |
|  +-----------------------------------------------------+  |
|            |                                    |         |
|            v                                    v         |
|  +-------------------+              +------------------+  |
|  | Embedded SQLite   |              | External Webhook |  |
|  | Database (WAL)    |              | (Slack / Pager)  |  |
|  +-------------------+              +------------------+  |
+-----------------------------------------------------------+
```

## Lifecycle States

1. **Initialization**:
   - Validates environment configuration (`network`, `rpcUrl`, `dbPath`, etc.).
   - Runs SQLite schema migrations and enables WAL mode.
   - Instantiates `@sorottl/sdk` RPC client and Pino redacting logger.

2. **Monitoring Loop**:
   - Runs an immediate cycle upon start.
   - Periodic timer invokes `runCycle()`.
   - `runMutex` prevents overlapping runs if an RPC call or network jitter delays the previous cycle.

3. **Per-Key Isolation**:
   - Each watchlist item is processed in an isolated `try/catch`.
   - Individual RPC errors or missing keys do not abort the monitoring cycle for remaining items.

4. **Alert Suppression**:
   - Alerts are categorized (`low_ttl`, `ttl_reached`, `unknown_status`, `rpc_failure`, `config_failure`).
   - If an alert of the same category was created for that watchlist item within `alertCooldownMs`, subsequent notifications are suppressed to prevent alert fatigue.

5. **Graceful Shutdown**:
   - On `SIGINT` or `SIGTERM`, `KeeperDaemon.stop()` clears timers, signals running tasks via `AbortController`, and cleanly flushes SQLite transactions before exit.
