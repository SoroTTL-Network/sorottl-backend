import { describe, it, expect } from "vitest";
import { reconstructLedgerKey } from "../../src/watchlist/key-reconstructor.js";
import { xdr } from "@stellar/stellar-sdk";

describe("Watchlist Key Reconstructor", () => {
  const validContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const validWasmHashHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  it("reconstructs an instance key from contractId", () => {
    const result = reconstructLedgerKey({
      keyType: "instance",
      contractId: validContractId,
    });

    expect(result.keyType).toBe("instance");
    expect(result.key).toBeDefined();
    expect(result.keyXdr).toBeDefined();

    // Verify roundtrip parse via Stellar SDK
    const parsed = xdr.LedgerKey.fromXDR(result.keyXdr, "base64");
    expect(parsed.type).toBe("contractData");
    expect(parsed.contractData.durability.name).toBe("persistent");
    expect(parsed.contractData.key.type).toBe("scvLedgerKeyContractInstance");
  });

  it("reconstructs a contractCode key from 32-byte hex hash", () => {
    const result = reconstructLedgerKey({
      keyType: "contractCode",
      wasmHashHex: validWasmHashHex,
    });

    expect(result.keyType).toBe("contractCode");
    expect(result.key).toBeDefined();
    expect(result.keyXdr).toBeDefined();

    const parsed = xdr.LedgerKey.fromXDR(result.keyXdr, "base64");
    expect(parsed.type).toBe("contractCode");
  });

  it("reconstructs contractData key from explicit valid XDR base64", () => {
    // Generate valid instance key XDR to use as known valid contractData
    const dummy = reconstructLedgerKey({
      keyType: "instance",
      contractId: validContractId,
    });

    const result = reconstructLedgerKey({
      keyType: "contractData",
      keyXdr: dummy.keyXdr,
    });

    expect(result.keyType).toBe("contractData");
    expect(result.keyXdr).toBe(dummy.keyXdr);
  });

  it("rejects instance reconstruction without contractId", () => {
    expect(() =>
      reconstructLedgerKey({
        keyType: "instance",
      }),
    ).toThrow(/Contract ID is required/i);
  });

  it("rejects instance reconstruction with invalid contractId format", () => {
    expect(() =>
      reconstructLedgerKey({
        keyType: "instance",
        contractId: "invalid-id",
      }),
    ).toThrow();
  });

  it("rejects contractCode reconstruction with invalid hex hash", () => {
    expect(() =>
      reconstructLedgerKey({
        keyType: "contractCode",
        wasmHashHex: "xyz-not-hex",
      }),
    ).toThrow(/hexadecimal Wasm hash/i);
  });

  it("rejects malformed base64 for contractData", () => {
    expect(() =>
      reconstructLedgerKey({
        keyType: "contractData",
        keyXdr: "not-valid-xdr",
      }),
    ).toThrow();
  });
});
