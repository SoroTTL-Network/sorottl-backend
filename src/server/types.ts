import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseClient } from "../db/client.js";
import type { Logger } from "../logging/logger.js";
import type { ISoroRpcClient } from "@sorottl/sdk";

export interface HttpServerOptions {
  readonly db: DatabaseClient;
  readonly rpcClient?: ISoroRpcClient | undefined;
  readonly logger: Logger;
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly network?: string | undefined;
  readonly authToken?: string | undefined;
  readonly corsOrigin?: string | undefined;
  readonly isKeeperRunning?: (() => boolean) | undefined;
}

export interface ApiResponse<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  readonly pagination?: {
    readonly limit: number;
    readonly offset: number;
    readonly returned: number;
  };
  readonly timestamp: string;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HttpServerContext,
) => Promise<void> | void;

export interface HttpServerContext {
  readonly db: DatabaseClient;
  readonly rpcClient?: ISoroRpcClient | undefined;
  readonly logger: Logger;
  readonly network: string;
  readonly authToken?: string | undefined;
  readonly corsOrigin?: string | undefined;
  readonly isKeeperRunning?: (() => boolean) | undefined;
  readonly startedAt: number;
  // Per-server instance RPC health cache and coalescing state
  lastRpcCheckTime?: number | undefined;
  cachedRpcResult?: { rpcStatus: string; currentLedger: number | null } | undefined;
  inFlightRpcCheck?:
    Promise<{ rpcStatus: string; currentLedger: number | null }> | null | undefined;
}
