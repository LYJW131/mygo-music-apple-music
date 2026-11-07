// AES-128: CBC decryption for the content keys, and CMAC for the key that
// encrypts them.

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);

// The S-box, worked out rather than written down.
{
  let p = 1;
  let q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
}

const xtime = (b: number): number => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;

function gmul(a: number, b: number): number {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return r;
}

function expandKey(key: Uint8Array): Uint8Array {
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4];
    let t1 = w[i - 3];
    let t2 = w[i - 2];
    let t3 = w[i - 1];
    if (i % 16 === 0) {
      [t0, t1, t2, t3] = [SBOX[t1] ^ rcon, SBOX[t2], SBOX[t3], SBOX[t0]];
      rcon = xtime(rcon);
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

function encryptBlock(w: Uint8Array, input: Uint8Array): Uint8Array {
  const s = Uint8Array.from(input);
  for (let i = 0; i < 16; i++) s[i] ^= w[i];
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    // ShiftRows
    [s[1], s[5], s[9], s[13]] = [s[5], s[9], s[13], s[1]];
    [s[2], s[10]] = [s[10], s[2]];
    [s[6], s[14]] = [s[14], s[6]];
    [s[3], s[7], s[11], s[15]] = [s[15], s[3], s[7], s[11]];
    if (round < 10) {
      // MixColumns
      for (let c = 0; c < 16; c += 4) {
        const [a0, a1, a2, a3] = [s[c], s[c + 1], s[c + 2], s[c + 3]];
        const all = a0 ^ a1 ^ a2 ^ a3;
        s[c] ^= all ^ xtime(a0 ^ a1);
        s[c + 1] ^= all ^ xtime(a1 ^ a2);
        s[c + 2] ^= all ^ xtime(a2 ^ a3);
        s[c + 3] ^= all ^ xtime(a3 ^ a0);
      }
    }
    for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
  }
  return s;
}

function decryptBlock(w: Uint8Array, input: Uint8Array): Uint8Array {
  const s = Uint8Array.from(input);
  for (let i = 0; i < 16; i++) s[i] ^= w[160 + i];
  for (let round = 9; round >= 0; round--) {
    // InvShiftRows
    [s[1], s[5], s[9], s[13]] = [s[13], s[1], s[5], s[9]];
    [s[2], s[10]] = [s[10], s[2]];
    [s[6], s[14]] = [s[14], s[6]];
    [s[3], s[7], s[11], s[15]] = [s[7], s[11], s[15], s[3]];
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
    if (round > 0) {
      // InvMixColumns
      for (let c = 0; c < 16; c += 4) {
        const [a0, a1, a2, a3] = [s[c], s[c + 1], s[c + 2], s[c + 3]];
        s[c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
        s[c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
        s[c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
        s[c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
      }
    }
  }
  return s;
}

/** AES-128-CBC, taking off PKCS#7 padding. */
export function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let i = 0; i < data.length; i += 16) {
    const block = data.subarray(i, i + 16);
    const plain = decryptBlock(w, block);
    for (let j = 0; j < 16; j++) out[i + j] = plain[j] ^ prev[j];
    prev = block;
  }
  const pad = out[out.length - 1];
  return pad > 0 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
}

/** AES-CMAC, RFC 4493. */
export function aesCmac(key: Uint8Array, message: Uint8Array): Uint8Array {
  const w = expandKey(key);
  const shift = (b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = ((b[i] << 1) | (i < 15 ? b[i + 1] >> 7 : 0)) & 0xff;
    if (b[0] & 0x80) out[15] ^= 0x87;
    return out;
  };
  const k1 = shift(encryptBlock(w, new Uint8Array(16)));
  const k2 = shift(k1);
  const n = Math.max(1, Math.ceil(message.length / 16));
  const complete = message.length > 0 && message.length % 16 === 0;
  const last = new Uint8Array(16);
  last.set(message.subarray((n - 1) * 16));
  if (complete) {
    for (let i = 0; i < 16; i++) last[i] ^= k1[i];
  } else {
    last[message.length - (n - 1) * 16] = 0x80;
    for (let i = 0; i < 16; i++) last[i] ^= k2[i];
  }
  let x: Uint8Array = new Uint8Array(16);
  for (let b = 0; b < n - 1; b++) {
    for (let i = 0; i < 16; i++) x[i] ^= message[b * 16 + i];
    x = encryptBlock(w, x);
  }
  for (let i = 0; i < 16; i++) x[i] ^= last[i];
  return encryptBlock(w, x);
}
