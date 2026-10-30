/**
 * Thence backend — Nimiq signature verification + address derivation (B1).
 *
 * Official scheme (do NOT modify without re-verifying against sources):
 *
 * 1. `sign()` (Nimiq Pay Mini App provider, @nimiq/mini-app-sdk 0.2.x) accepts
 *    `message: string | { message, isHex? }` and returns
 *    `{ publicKey, signature }` as hex strings.
 *    Source: https://nimiq.dev/mini-apps/api-reference/nimiq-provider
 * 2. The host signs exactly like the reference Keyguard implementation
 *    (`nimiq/keyguard`, `Key.signMessage`, `SignMessage`):
 *      data = PREFIX + len(messageBytes).toString(10) + messageBytes
 *    with PREFIX = SignMessagePrefix.SIGNED_MESSAGE, then SHA-256, then
 *    Ed25519 sign of the hash.
 *    Sources: keyguard `src/lib/Key.js`, `client/src/SignMessagePrefix.ts`:
 *      SIGNED_MESSAGE = '\x16Nimiq Signed Message:\n'
 * 3. Nimiq signatures are raw Ed25519 (core-rs `keys::Signature` wraps
 *    `ed25519_dalek::Signature`, 64 bytes; public keys are 32 bytes).
 * 4. Address = Blake2b-256(publicKey)[0..20], rendered as NQ IBAN-style
 *    user-friendly address (core-rs `keys::address::Address`).
 *
 * Host end-to-end (a real Nimiq Pay signature) still requires host
 * interaction and is marked pending; the cryptography below is verified
 * against RFC 8032 vectors and official Nimiq address vectors in tests.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { blake2b } from "@/lib/blake2b";

/** Official Nimiq signed-message prefix (first byte = remaining length 22). */
export const NIMIQ_SIGNED_MESSAGE_PREFIX = "\x16Nimiq Signed Message:\n";

/** Nimiq base32 alphabet (no I, O, W, Z) — core-rs `Address::NIMIQ_ALPHABET`. */
const NIMIQ_B32_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVXY";

/** Raw Ed25519 sizes. */
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
/** DER prefix wrapping a raw Ed25519 key into SPKI for node:crypto. */
const ED25519_SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class NimiqFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NimiqFormatError";
  }
}

/** Strict hex decode: optional 0x, exact byte length, hex chars only. */
export function parseHexStrict(value: string, expectedBytes: number, label: string): Buffer {
  if (typeof value !== "string") throw new NimiqFormatError(`${label} must be a string`);
  const clean = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length !== expectedBytes * 2) {
    throw new NimiqFormatError(`${label} must be ${expectedBytes * 2} hex chars`);
  }
  return Buffer.from(clean, "hex");
}

/** Message bytes exactly as the host signs them: string → UTF-8, bytes → raw. */
export function messageToBytes(message: string | Uint8Array): Buffer {
  if (typeof message === "string") return Buffer.from(message, "utf8");
  return Buffer.from(message.buffer, message.byteOffset, message.byteLength);
}

/**
 * Exact pre-hash payload: PREFIX + decimal ASCII byte-length + message bytes.
 * Byte-identical to keyguard `Key.signMessage`.
 */
export function buildSignPayload(message: string | Uint8Array): Buffer {
  const bytes = messageToBytes(message);
  return Buffer.concat([
    Buffer.from(NIMIQ_SIGNED_MESSAGE_PREFIX, "utf8"),
    Buffer.from(bytes.length.toString(10), "utf8"),
    bytes,
  ]);
}

export function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Raw Ed25519 verification of a 32-byte digest. Exported so tests can check
 * the primitive against RFC 8032 vectors independently of the Nimiq scheme.
 */
export function verifyEd25519Raw(publicKey: Uint8Array, digest: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES || signature.length !== ED25519_SIGNATURE_BYTES) {
    return false;
  }
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_DER_PREFIX, Buffer.from(publicKey)]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(digest), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Verify an official Nimiq signed message. Returns true only when the
 * Ed25519 signature is valid for SHA256(prefix‖len‖message) under the
 * given public key. Malformed inputs throw NimiqFormatError; a bad
 * signature returns false (never throws).
 */
export function verifyNimiqSignature(args: {
  publicKeyHex: string;
  signatureHex: string;
  message: string | Uint8Array;
}): boolean {
  const publicKey = parseHexStrict(args.publicKeyHex, ED25519_PUBLIC_KEY_BYTES, "publicKey");
  const signature = parseHexStrict(args.signatureHex, ED25519_SIGNATURE_BYTES, "signature");
  const digest = sha256(buildSignPayload(args.message));
  return verifyEd25519Raw(publicKey, digest, signature);
}

/**
 * Blake2b-256 digest (32-byte output), as used by core-rs address derivation.
 * Pure-TS RFC 7693 implementation (see src/lib/blake2b.ts) — this
 * environment's OpenSSL exposes no Blake2b-256 alias.
 */
export function blake2b256(data: Uint8Array): Buffer {
  return blake2b(data, 32);
}

/** 20-byte address bytes from a 32-byte Ed25519 public key (core-rs `Address::from`). */
export function addressBytesFromPublicKey(publicKeyHex: string): Buffer {
  const publicKey = parseHexStrict(publicKeyHex, ED25519_PUBLIC_KEY_BYTES, "publicKey");
  return blake2b256(publicKey).subarray(0, 20);
}

/** Nimiq base32 encode (no padding) over the Nimiq alphabet. */
export function nimiqBase32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += NIMIQ_B32_ALPHABET[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += NIMIQ_B32_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** Nimiq base32 decode. Throws NimiqFormatError on alphabet violations. */
export function nimiqBase32Decode(encoded: string): Buffer {
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of encoded.toUpperCase()) {
    const val = NIMIQ_B32_ALPHABET.indexOf(ch);
    if (val < 0) throw new NimiqFormatError("invalid Nimiq base32 character");
    acc = (acc << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 255);
    }
  }
  return Buffer.from(out);
}

/** IBAN mod-97 over an expanded string, in 6-char chunks (core-rs `iban_check`). */
function ibanMod97(expanded: string): number {
  let digits = "";
  for (const ch of expanded.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) digits += ch;
    else digits += String(code - 55);
  }
  let remainder = "";
  for (let i = 0; i < digits.length; i += 6) {
    remainder = String(Number(remainder + digits.slice(i, i + 6)) % 97);
  }
  return Number(remainder);
}

/** Friendly address from 20 address bytes (core-rs `to_user_friendly_address`). */
export function toUserFriendlyAddress(addressBytes: Uint8Array): string {
  if (addressBytes.length !== 20) throw new NimiqFormatError("address must be 20 bytes");
  const base32 = nimiqBase32Encode(addressBytes);
  const check = 98 - ibanMod97(base32 + "NQ00");
  const friendly = `NQ${String(check).padStart(2, "0")}${base32}`;
  const groups: string[] = [];
  for (let i = 0; i < 9; i++) groups.push(friendly.slice(i * 4, i * 4 + 4));
  return groups.join(" ");
}

/** Derive the NQ user-friendly address from a hex Ed25519 public key. */
export function deriveNimiqAddress(publicKeyHex: string): string {
  return toUserFriendlyAddress(addressBytesFromPublicKey(publicKeyHex));
}

/**
 * Validate + normalize a user-supplied Nimiq address. Returns the canonical
 * spaced form. Throws NimiqFormatError on wrong country code, length,
 * checksum or alphabet.
 */
export function normalizeNimiqAddress(input: string): string {
  if (typeof input !== "string") throw new NimiqFormatError("address must be a string");
  const compact = input.replace(/ /g, "");
  if (compact.length !== 36) throw new NimiqFormatError("address must be 36 chars");
  if (compact.slice(0, 2).toUpperCase() !== "NQ") {
    throw new NimiqFormatError("address must start with NQ");
  }
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  if (ibanMod97(rearranged) !== 1) throw new NimiqFormatError("address checksum invalid");
  const bytes = nimiqBase32Decode(compact.slice(4));
  if (bytes.length !== 20) throw new NimiqFormatError("address payload must decode to 20 bytes");
  return toUserFriendlyAddress(bytes);
}

/** Non-throwing address validity check. */
export function isValidNimiqAddress(input: string): boolean {
  try {
    normalizeNimiqAddress(input);
    return true;
  } catch {
    return false;
  }
}
