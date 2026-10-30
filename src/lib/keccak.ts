/**
 * Minimal pure-TypeScript Keccak-256 (the pre-NIST Ethereum variant, not
 * SHA3-256 — different padding). Needed for EIP-55 mixed-case address
 * checksums. No runtime in this environment exposes raw Keccak-256.
 *
 * Validated in tests against the well-known vector
 * keccak256("") = c5d24601…5a470.
 */
const MASK = (1n << 64n) - 1n;

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROTATION_OFFSETS: readonly (readonly number[])[] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(x: bigint, n: number): bigint {
  const s = BigInt(n % 64);
  if (s === 0n) return x & MASK;
  return ((x << s) | (x >> (64n - s))) & MASK;
}

function keccakF1600(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // Theta
    const c: bigint[] = [];
    for (let x = 0; x < 5; x++) {
      c.push(
        ((state[x] as bigint) ^ (state[x + 5] as bigint) ^ (state[x + 10] as bigint) ^
          (state[x + 15] as bigint) ^ (state[x + 20] as bigint)) & MASK,
      );
    }
    const d: bigint[] = [];
    for (let x = 0; x < 5; x++) {
      d.push(((c[(x + 4) % 5] as bigint) ^ rotl(c[(x + 1) % 5] as bigint, 1)) & MASK);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) state[x + 5 * y] = ((state[x + 5 * y] as bigint) ^ (d[x] as bigint)) & MASK;
    }
    // Rho + Pi
    const b: bigint[] = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y] as bigint, ((ROTATION_OFFSETS[x] as readonly number[])[y] as number) ?? 0);
      }
    }
    // Chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] =
          ((b[x + 5 * y] as bigint) ^ ((~(b[(x + 1) % 5 + 5 * y] as bigint)) & (b[(x + 2) % 5 + 5 * y] as bigint))) & MASK;
      }
    }
    // Iota
    state[0] = ((state[0] as bigint) ^ (ROUND_CONSTANTS[round] as bigint)) & MASK;
  }
}

/**
 * Keccak-256 digest (Ethereum variant: suffix 0x01, rate 1088 bits).
 * Throws on non-byte input misuse (defensive; callers pass Buffers).
 */
export function keccak256(data: Uint8Array): Buffer {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const rateInBytes = 136; // 1088 bits
  const state: bigint[] = new Array<bigint>(25).fill(0n);
  const paddedLength = Math.floor(bytes.length / rateInBytes) * rateInBytes;
  for (let off = 0; off < paddedLength; off += rateInBytes) {
    const block = bytes.subarray(off, off + rateInBytes);
    for (let i = 0; i < rateInBytes / 8; i++) {
      let w = 0n;
      for (let j = 0; j < 8; j++) w |= BigInt(block[i * 8 + j] as number) << BigInt(8 * j);
      state[i] = ((state[i] as bigint) ^ w) & MASK;
    }
    keccakF1600(state);
  }
  // Final block with Keccak suffix 0x01 and pad10*1.
  const tail = bytes.subarray(paddedLength);
  const block = Buffer.alloc(rateInBytes, 0);
  tail.copy(block);
  block[tail.length] = ((block[tail.length] as number) ^ 0x01) & 0xff;
  block[rateInBytes - 1] = ((block[rateInBytes - 1] as number) ^ 0x80) & 0xff;
  for (let i = 0; i < rateInBytes / 8; i++) {
    let w = 0n;
    for (let j = 0; j < 8; j++) w |= BigInt(block[i * 8 + j] as number) << BigInt(8 * j);
    state[i] = ((state[i] as bigint) ^ w) & MASK;
  }
  keccakF1600(state);
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    let w = state[i] as bigint;
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(w & 0xffn);
      w >>= 8n;
    }
  }
  return out;
}
