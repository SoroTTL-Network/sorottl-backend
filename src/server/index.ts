import * as http from "node:http";
import type { HttpServerOptions, HttpServerContext } from "./types.js";
import { handleRequest } from "./router.js";

/**
 * Lightweight, read-only HTTP API server for SoroTTL health, inspection, and dashboard queries.
 */
export class HttpServer {
  private server: http.Server | null = null;
  private readonly context: HttpServerContext;
  private readonly port: number;
  private readonly host: string;
  private _isListening: boolean = false;

  constructor(options: HttpServerOptions) {
    this.port = options.port ?? 8080;
    this.host = options.host ?? "127.0.0.1";
    this.context = {
      db: options.db,
      rpcClient: options.rpcClient,
      logger: options.logger,
      network: options.network ?? "testnet",
      authToken: options.authToken,
      corsOrigin: options.corsOrigin,
      isKeeperRunning: options.isKeeperRunning,
      startedAt: Date.now(),
    };
  }

  /**
   * Starts the HTTP server and binds to configured host/port.
   */
  public async start(): Promise<{ port: number; host: string }> {
    if (this._isListening && this.server) {
      const address = this.server.address();
      const actualPort = typeof address === "object" && address ? address.port : this.port;
      return { port: actualPort, host: this.host };
    }

    // Security warning on non-loopback binding
    if (this.host !== "127.0.0.1" && this.host !== "localhost" && this.host !== "::1") {
      this.context.logger.warn(
        { host: this.host, port: this.port },
        "[SECURITY WARNING]: SoroTTL HTTP API is bound to a non-loopback network interface. Ensure this service is protected behind a reverse proxy, VPN, or firewall.",
      );
    }

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        void handleRequest(req, res, this.context);
      });

      // Guard against Slowloris and stalled connections
      srv.headersTimeout = 5000;
      srv.requestTimeout = 10000;

      srv.on("error", (err) => {
        this.context.logger.error({ err }, "HTTP server error");
        reject(err);
      });

      srv.listen(this.port, this.host, () => {
        this._isListening = true;
        this.server = srv;
        const address = srv.address();
        const actualPort = typeof address === "object" && address ? address.port : this.port;
        this.context.logger.info(
          { port: actualPort, host: this.host },
          "SoroTTL read-only HTTP API server listening",
        );
        resolve({ port: actualPort, host: this.host });
      });
    });
  }

  /**
   * Gracefully shuts down the HTTP server without terminating underlying shared DB or RPC resources.
   */
  public async stop(): Promise<void> {
    if (!this.server || !this._isListening) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        this._isListening = false;
        this.server = null;
        if (err) {
          this.context.logger.error({ err }, "Error closing HTTP server");
          reject(err);
        } else {
          this.context.logger.info("SoroTTL HTTP API server closed cleanly");
          resolve();
        }
      });
    });
  }

  public isListening(): boolean {
    return this._isListening;
  }

  public getPort(): number {
    if (this.server) {
      const address = this.server.address();
      if (typeof address === "object" && address) {
        return address.port;
      }
    }
    return this.port;
  }
}
