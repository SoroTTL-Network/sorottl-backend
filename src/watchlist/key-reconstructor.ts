import {
  buildContractCodeKey,
  buildContractInstanceKey,
  validateContractId,
  validateLedgerKey,
} from "@sorottl/sdk";
import { xdr } from "@stellar/stellar-sdk";
import type { ReconstructedKey, WatchlistKeyType } from "../types/domain.js";

/**
 * Reconstructs and validates a supported SDK xdr.LedgerKey from watchlist attributes.
 *
 * Supported key types:
 * - 'instance': Reconstructed via contract ID or raw XDR
 * - 'contractCode': Reconstructed via Wasm hash hex or raw XDR
 * - 'contractData': Reconstructed from canonical base64 XDR
 *
 * @param keyType - Type of key
 * @param keyXdr - Canonical base64 XDR string
 * @param contractId - Optional contract address ('C...')
 */
export interface ReconstructKeyParams {
  readonly keyType: WatchlistKeyType;
  readonly keyXdr?: string | null | undefined;
  readonly contractId?: string | null | undefined;
  readonly wasmHashHex?: string | null | undefined;
}

/**
 * Reconstructs and validates a supported SDK xdr.LedgerKey from watchlist attributes.
 *
 * Supported key types:
 * - 'instance': Reconstructed via contract ID or raw XDR
 * - 'contractCode': Reconstructed via Wasm hash hex or raw XDR
 * - 'contractData': Reconstructed from canonical base64 XDR
 */
export function reconstructLedgerKey(
  paramsOrType: ReconstructKeyParams | WatchlistKeyType,
  rawKeyXdr?: string,
  rawContractId?: string | null,
): ReconstructedKey {
  let keyType: WatchlistKeyType;
  let keyXdr: string | undefined;
  let contractId: string | null | undefined;
  let wasmHashHex: string | null | undefined;

  if (typeof paramsOrType === "object" && paramsOrType !== null) {
    keyType = paramsOrType.keyType;
    keyXdr = paramsOrType.keyXdr ?? undefined;
    contractId = paramsOrType.contractId;
    wasmHashHex = paramsOrType.wasmHashHex;
  } else {
    keyType = paramsOrType;
    keyXdr = rawKeyXdr;
    contractId = rawContractId;
  }

  let key: xdr.LedgerKey;

  try {
    if (keyType === "instance") {
      if (contractId) {
        validateContractId(contractId);
        key = buildContractInstanceKey(contractId);
      } else if (keyXdr) {
        key = xdr.LedgerKey.fromXDR(keyXdr, "base64");
      } else {
        throw new Error("Contract ID is required for instance key reconstruction");
      }
    } else if (keyType === "contractCode") {
      const hex = wasmHashHex || keyXdr;
      if (hex && /^[0-9a-f]{64}$/i.test(hex)) {
        key = buildContractCodeKey(hex);
      } else if (keyXdr && !wasmHashHex) {
        key = xdr.LedgerKey.fromXDR(keyXdr, "base64");
      } else {
        throw new Error("Valid 32-byte hexadecimal Wasm hash is required for contractCode");
      }
    } else {
      // Decode from canonical base64 XDR
      if (!keyXdr) {
        throw new Error("Base64 keyXdr is required for contractData");
      }
      key = xdr.LedgerKey.fromXDR(keyXdr, "base64");
    }
  } catch (err) {
    throw new Error(
      `Failed to reconstruct LedgerKey (type: '${keyType}', keyXdr: '${keyXdr}'): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Validate through SDK's validateLedgerKey
  validateLedgerKey(key);

  const canonicalXdr = key.toXDR("base64");

  return {
    key,
    keyXdr: canonicalXdr,
    keyType,
  };
}
