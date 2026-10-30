/**
 * B1 — Nimiq cryptography tests (pure, no database).
 *
 * Independence strategy (no circular self-verification):
 * - Ed25519 primitive checked against the RFC 8032 TEST 1 vector.
 * - Address base32 + IBAN checked against Nimiq's documented burn address
 *   NQ07 0000… (all-zero payload), independent of our own key generation.
 * - The prefixed payload construction is pinned byte-for-byte to the
 *   official keyguard scheme (prefix constant + decimal length + UTF-8).
 * - Composition (sign→verify→derive) uses freshly generated keys, with the
 *   layers above already pinned independently.
 */
import { describe, expect, it } from "vitest";
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { blake2b } from "@/lib/blake2b";
import {
  NIMIQ_SIGNED_MESSAGE_PREFIX,
  NimiqFormatError,
  addressBytesFromPublicKey,
  buildSignPayload,
  deriveNimiqAddress,
  isValidNimiqAddress,
  messageToBytes,
  nimiqBase32Decode,
  nimiqBase32Encode,
  normalizeNimiqAddress,
  sha256,
  toUserFriendlyAddress,
  verifyEd25519Raw,
  verifyNimiqSignature,
} from "@/lib/nimiq";

const hex = (s: string): Buffer => Buffer.from(s, "hex");

describe("official signed-message payload", () => {
  it("pins the exact prefix constant from keyguard SignMessagePrefix", () => {
    expect(NIMIQ_SIGNED_MESSAGE_PREFIX).toBe("\x16Nimiq Signed Message:\n");
    const prefixBytes = Buffer.from(NIMIQ_SIGNED_MESSAGE_PREFIX, "utf8");
    expect(prefixBytes[0]).toBe(0x16); // first byte = remaining prefix length (22)
    expect(prefixBytes.length).toBe(23);
  });

  it("builds prefix + decimal length + UTF-8 bytes (keyguard Key.signMessage)", () => {
    expect(buildSignPayload("hello").toString("hex")).toBe(
      Buffer.concat([
        Buffer.from([0x16]),
        Buffer.from("Nimiq Signed Message:\n", "utf8"),
        Buffer.from("5", "utf8"),
        Buffer.from("hello", "utf8"),
      ]).toString("hex"),
    );
  });

  it("treats string and Uint8Array inputs identically, UTF-8 encoded", () => {
    const text = "Thence login ünicode ✓";
    expect(buildSignPayload(text).equals(buildSignPayload(new TextEncoder().encode(text)))).toBe(true);
    expect(messageToBytes(text).equals(Buffer.from(text, "utf8"))).toBe(true);
  });
});

describe("BLAKE2b core (RFC 7693, validated against native BLAKE2b-512)", () => {
  const native512 = (input: string): string => createHash("blake2b512").update(input, "utf8").digest("hex");
  it("matches native BLAKE2b-512 on several inputs (same code path as -256)", () => {
    for (const input of ["", "a", "abc", "hello world", "x".repeat(300)]) {
      expect(blake2b(Buffer.from(input, "utf8"), 64).toString("hex")).toBe(native512(input));
    }
  });
  it("matches the known BLAKE2b-512(abc) prefix ba80a53f", () => {
    expect(native512("abc").startsWith("ba80a53f981c4d0d")).toBe(true);
    expect(blake2b(Buffer.from("abc", "utf8"), 64).toString("hex").startsWith("ba80a53f981c4d0d")).toBe(true);
  });
  it("rejects out-of-range digest lengths", () => {
    expect(() => blake2b(Buffer.alloc(0), 0)).toThrow();
    expect(() => blake2b(Buffer.alloc(0), 65)).toThrow();
  });
});

describe("Ed25519 primitive (RFC 8032 TEST 1, empty message)", () => {
  const pubkey = hex(
    "d75a980182b10ab7d54bfed3c964073a" + "0ee172f3daa62325af021a68f707511a",
  );
  const sig = hex(
    "e5564300c360ac729086e2cc806e828a" +
      "84877f1eb8e5d974d873e06522490155" +
      "5fb8821590a33bacc61e39701cf9b46b" +
      "d25bf5f0595bbe24655141438e7a100b",
  );
  it("accepts the official test vector", () => {
    expect(verifyEd25519Raw(pubkey, Buffer.alloc(0), sig)).toBe(true);
  });
  it("rejects a tampered signature bit", () => {
    const bad = Buffer.from(sig);
    bad[0] = (bad[0] as number) ^ 1;
    expect(verifyEd25519Raw(pubkey, Buffer.alloc(0), bad)).toBe(false);
  });
  it("rejects wrong sizes without throwing", () => {
    expect(verifyEd25519Raw(pubkey.subarray(0, 31), Buffer.alloc(0), sig)).toBe(false);
  });
});

describe("Nimiq address derivation (core-rs keys::address::Address)", () => {
  it("renders the documented all-zero burn address NQ07 0000…", () => {
    expect(toUserFriendlyAddress(Buffer.alloc(20))).toBe("NQ07 0000 0000 0000 0000 0000 0000 0000 0000");
  });

  it("round-trips arbitrary payloads through base32 + IBAN check", () => {
    const payload = Buffer.from("00112233445566778899aabbccddeeff00112233", "hex");
    const friendly = toUserFriendlyAddress(payload);
    expect(isValidNimiqAddress(friendly)).toBe(true);
    expect(nimiqBase32Decode(friendly.replace(/ /g, "").slice(4)).equals(payload)).toBe(true);
    expect(normalizeNimiqAddress(friendly.toLowerCase().replace(/ /g, ""))).toBe(friendly);
  });

  it("rejects bad checksum, country code and length", () => {
    expect(isValidNimiqAddress("NQ08 0000 0000 0000 0000 0000 0000 0000 0000")).toBe(false);
    expect(isValidNimiqAddress("NQ07 0000 0000 0000 0000 0000 0000 0000 000")).toBe(false);
    expect(isValidNimiqAddress("XX07 0000 0000 0000 0000 0000 0000 0000 0000")).toBe(false);
    expect(isValidNimiqAddress("not an address")).toBe(false);
    expect(() => normalizeNimiqAddress("NQ08 0000 0000 0000 0000 0000 0000 0000 0000")).toThrow(
      NimiqFormatError,
    );
  });

  it("base32 rejects out-of-alphabet characters (no I, O, W, Z)", () => {
    expect(() => nimiqBase32Decode("IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII")).toThrow(NimiqFormatError);
    expect(nimiqBase32Encode(Buffer.alloc(20))).toBe("00000000000000000000000000000000");
  });
});

describe("official-compatible sign → verify → derive composition", () => {
  function freshKeypair(): { publicKeyHex: string; signDigest: (digest: Buffer) => Buffer } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
    const keyObject = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    return {
      publicKeyHex: Buffer.from(rawPublic).toString("hex"),
      signDigest: (digest: Buffer) => sign(null, digest, keyObject),
    };
  }

  it("verifies a freshly signed challenge and derives a stable valid address", () => {
    const { publicKeyHex, signDigest } = freshKeypair();
    const message = "Sign in to Thence\n\nPurpose: wallet authentication\nApp: thence\nNonce: abc\nExpires: never";
    const signatureHex = signDigest(sha256(buildSignPayload(message))).toString("hex");
    expect(verifyNimiqSignature({ publicKeyHex, signatureHex, message })).toBe(true);
    const address = deriveNimiqAddress(publicKeyHex);
    expect(isValidNimiqAddress(address)).toBe(true);
    expect(addressBytesFromPublicKey(publicKeyHex).length).toBe(20);
    // Deterministic: same key always derives the same address.
    expect(deriveNimiqAddress(publicKeyHex)).toBe(address);
  });

  it("rejects wrong message, wrong key and flipped bytes", () => {
    const alice = freshKeypair();
    const bob = freshKeypair();
    const message = "challenge-one";
    const signatureHex = alice.signDigest(sha256(buildSignPayload(message))).toString("hex");
    expect(verifyNimiqSignature({ publicKeyHex: alice.publicKeyHex, signatureHex, message: "challenge-two" })).toBe(
      false,
    );
    expect(verifyNimiqSignature({ publicKeyHex: bob.publicKeyHex, signatureHex, message })).toBe(false);
    const bad = hex(signatureHex);
    bad[63] = (bad[63] as number) ^ 1;
    expect(
      verifyNimiqSignature({ publicKeyHex: alice.publicKeyHex, signatureHex: bad.toString("hex"), message }),
    ).toBe(false);
  });

  it("throws NimiqFormatError on malformed inputs (never verifies garbage)", () => {
    const { publicKeyHex, signDigest } = freshKeypair();
    const signatureHex = signDigest(sha256(buildSignPayload("m"))).toString("hex");
    expect(() => verifyNimiqSignature({ publicKeyHex: "zz", signatureHex, message: "m" })).toThrow(
      NimiqFormatError,
    );
    expect(() => verifyNimiqSignature({ publicKeyHex, signatureHex: signatureHex.slice(0, 126), message: "m" })).toThrow(
      NimiqFormatError,
    );
    expect(() => deriveNimiqAddress(publicKeyHex.slice(0, 62))).toThrow(NimiqFormatError);
  });
});
