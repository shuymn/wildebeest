// A synchronous, incremental SHA-256 whose running state can be saved as a string and restored later. Dump and
// verification hash one table across many RPCs, and crypto.subtle neither streams nor exposes its state.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const encoder = new TextEncoder();

export class Sha256 {
  readonly #h = new Uint32Array(INITIAL);
  readonly #block = new Uint8Array(64);
  readonly #w = new Uint32Array(64);
  #buffered = 0;
  #length = 0; // bytes hashed so far; exact up to 2^53

  update(data: Uint8Array | string): this {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    let offset = 0;
    this.#length += bytes.length;
    if (this.#buffered > 0) {
      const take = Math.min(64 - this.#buffered, bytes.length);
      this.#block.set(bytes.subarray(0, take), this.#buffered);
      this.#buffered += take;
      offset = take;
      if (this.#buffered < 64) {
        return this;
      }
      this.#compress(this.#block, 0);
      this.#buffered = 0;
    }
    for (; offset + 64 <= bytes.length; offset += 64) {
      this.#compress(bytes, offset);
    }
    if (offset < bytes.length) {
      this.#block.set(bytes.subarray(offset), 0);
      this.#buffered = bytes.length - offset;
    }
    return this;
  }

  // Finishes a copy, so the running state stays usable.
  hex(): string {
    const copy = Sha256.restore(this.save());
    return copy.#finish();
  }

  save(): string {
    const h = Array.from(this.#h, (v) => v.toString(16).padStart(8, "0")).join("");
    const pending = Array.from(this.#block.subarray(0, this.#buffered), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    return `${h}:${this.#length}:${pending}`;
  }

  static restore(saved: string): Sha256 {
    const match = /^([0-9a-f]{64}):(\d{1,16}):((?:[0-9a-f]{2}){0,63})$/.exec(saved);
    if (match === null) {
      throw new Error("invalid hash state");
    }
    const [, h = "", length = "0", pending = ""] = match;
    const hash = new Sha256();
    for (let i = 0; i < 8; i++) {
      hash.#h[i] = parseInt(h.slice(i * 8, i * 8 + 8), 16);
    }
    hash.#length = Number(length);
    hash.#buffered = pending.length / 2;
    if ((hash.#length - hash.#buffered) % 64 !== 0) {
      throw new Error("invalid hash state");
    }
    for (let i = 0; i < hash.#buffered; i++) {
      hash.#block[i] = parseInt(pending.slice(i * 2, i * 2 + 2), 16);
    }
    return hash;
  }

  #finish(): string {
    const bits = this.#length * 8;
    const tail = new Uint8Array((this.#buffered < 56 ? 64 : 128) - this.#buffered);
    tail[0] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(tail.length - 4, bits >>> 0);
    const length = this.#length;
    this.update(tail);
    this.#length = length;
    return Array.from(this.#h, (v) => v.toString(16).padStart(8, "0")).join("");
  }

  #compress(bytes: Uint8Array, offset: number): void {
    const w = this.#w;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((bytes[j]! << 24) | (bytes[j + 1]! << 16) | (bytes[j + 2]! << 8) | bytes[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    const h = this.#h;
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let k = h[7]!;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (k + s1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + k) >>> 0;
  }
}

export function sha256Hex(data: Uint8Array | string): string {
  return new Sha256().update(data).hex();
}
