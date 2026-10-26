import pino from "pino";

/**
 * List of sensitive key names to redact automatically in log payloads.
 */
const SENSITIVE_KEYS = [
  "secret",
  "secretKey",
  "secret_key",
  "privateKey",
  "private_key",
  "seedPhrase",
  "mnemonic",
  "password",
  "token",
  "authorization",
  "auth",
];

/**
 * Creates a configured Pino logger instance with automatic redaction of sensitive credentials.
 */
export function createLogger(level: string = "info") {
  return pino({
    level,
    redact: {
      paths: SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
      censor: "[REDACTED_SECRET]",
    },
    base: {
      service: "sorottl-keeper",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
