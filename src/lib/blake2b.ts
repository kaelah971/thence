/**
 * Minimal pure-TypeScript BLAKE2b (RFC 7693) with configurable digest length.
 *
 * Why not node:crypto: this environment's OpenSSL rejects
 * `createHash("blake2b512", { outputLength: 32 })` and exposes no
 * `blake2b256` alias, but Nimiq address derivation (core-rs
 * `keys::address::Address::from`) requires Blake2b-256 — Blake2b with a
 * 32-byte digest. Parameterized Blake2b per RFC 7693 §3.2 is the exact
 * specified construction (not a truncation: the digest length is part of
 * the parameter block).
 *
 * Validation (see tests/nimiq.test.ts):
 * - 64-byte digests agree with node:crypto's native BLAKE2b-512 on multiple
 *   inputs (same code path; only the `nn` parameter byte differs for -256).
 * - Known-answer prefix: BLAKE2b-512("abc") = ba80a53f…
 */
const MASK = (1n << 64n) - 1n;

const IV: readonly bigint[] = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

function rotr(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK;
}

function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean): void {
  const m: bigint[] = new Array<bigint>(16);
  for (let i = 0; i < 16; i++) {
    let w = 0n;
    for (let j = 0; j < 8; j++) w |= BigInt(block[i * 8 + j] ?? 0) << BigInt(8 * j);
    m[i] = w;
  }
  const v: bigint[] = [...h, ...IV];
  v[12] = (v[12] as bigint) ^ (t & MASK);
  v[13] = (v[13] as bigint) ^ (t >> 64n);
  if (last) v[14] = (v[14] as bigint) ^ MASK;
  const G = (a: number, b: number, c: number, d: number, x: bigint, y: bigint): void => {
    v[a] = ((v[a] as bigint) + (v[b] as bigint) + x) & MASK;
    v[d] = rotr((v[d] as bigint) ^ (v[a] as bigint), 32n);
    v[c] = ((v[c] as bigint) + (v[d] as bigint)) & MASK;
    v[b] = rotr((v[b] as bigint) ^ (v[c] as bigint), 24n);
    v[a] = ((v[a] as bigint) + (v[b] as bigint) + y) & MASK;
    v[d] = rotr((v[d] as bigint) ^ (v[a] as bigint), 16n);
    v[c] = ((v[c] as bigint) + (v[d] as bigint)) & MASK;
    v[b] = rotr((v[b] as bigint) ^ (v[c] as bigint), 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r] as readonly number[];
    G(0, 4, 8, 12, m[s[0] as number] as bigint, m[s[1] as number] as bigint);
    G(1, 5, 9, 13, m[s[2] as number] as bigint, m[s[3] as number] as bigint);
    G(2, 6, 10, 14, m[s[4] as number] as bigint, m[s[5] as number] as bigint);
    G(3, 7, 11, 15, m[s[6] as number] as bigint, m[s[7] as number] as bigint);
    G(0, 5, 10, 15, m[s[8] as number] as bigint, m[s[9] as number] as bigint);
    G(1, 6, 11, 12, m[s[10] as number] as bigint, m[s[11] as number] as bigint);
    G(2, 7, 8, 13, m[s[12] as number] as bigint, m[s[13] as number] as bigint);
    G(3, 4, 9, 14, m[s[14] as number] as bigint, m[s[15] as number] as bigint);
  }
  for (let i = 0; i < 8; i++) h[i] = (h[i] as bigint) ^ (v[i] as bigint) ^ (v[i + 8] as bigint);
}

/**
 * BLAKE2b with digest length `outlen` (1–64), unkeyed, sequential mode.
 * Throws on out-of-range lengths.
 */
export function blake2b(data: Uint8Array, outlen: number): Buffer {
  if (!Number.isInteger(outlen) || outlen < 1 || outlen > 64) {
    throw new Error("BLAKE2b digest length must be 1–64 bytes");
  }
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const h: bigint[] = [...IV];
  // Parameter block: nn | kk<<8 | fanout<<16 | depth<<24, rest zero (RFC 7693 §2.5).
  const param = BigInt(outlen) | (0n << 8n) | (1n << 16n) | (1n << 24n);
  h[0] = (h[0] as bigint) ^ param;
  const blocks: Buffer[] = [];
  if (bytes.length === 0) {
    blocks.push(Buffer.alloc(128, 0));
  } else {
    for (let off = 0; off < bytes.length; off += 128) {
      const chunk = bytes.subarray(off, off + 128);
      blocks.push(chunk.length === 128 ? chunk : Buffer.concat([chunk, Buffer.alloc(128 - chunk.length, 0)]));
    }
  }
  let counter = 0n;
  blocks.forEach((block, index) => {
    const isLast = index === blocks.length - 1;
    const blockLen = isLast
      ? bytes.length === 0
        ? 0
        : bytes.length - index * 128
      : 128;
    counter += BigInt(blockLen);
    compress(h, block, counter, isLast);
  });
  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i++) {
    let w = h[i] as bigint;
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(w & 0xffn);
      w >>= 8n;
    }
  }
  return out.subarray(0, outlen);
}
