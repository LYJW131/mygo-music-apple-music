// RSA with the device's private key, in BigInt: RSASSA-PSS to sign the
// license request, RSAES-OAEP to read the session key out of the license.
// Both with SHA-1 and MGF1, as Widevine has them.

import { concat, hex, randomBytes } from "./bytes.ts";
import { sha1 } from "./sha1.ts";

export interface RSAKey {
  n: bigint;
  e: bigint;
  d: bigint;
  p: bigint;
  q: bigint;
  dp: bigint;
  dq: bigint;
  qinv: bigint;
  /** The modulus's length in bytes. */
  size: number;
}

function toBig(bytes: Uint8Array): bigint {
  return bytes.length ? BigInt("0x" + hex(bytes)) : 0n;
}

function fromBig(n: bigint, length: number): Uint8Array {
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  const out = new Uint8Array(length);
  const raw = (h.match(/../g) ?? []).map((x) => parseInt(x, 16));
  out.set(raw, length - raw.length);
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

/** A PKCS#1 RSAPrivateKey, from DER. */
export function parseRSAKey(der: Uint8Array): RSAKey {
  let at = 0;
  const readLength = (): number => {
    let length = der[at++];
    if (length & 0x80) {
      const n = length & 0x7f;
      length = 0;
      for (let i = 0; i < n; i++) length = length * 256 + der[at++];
    }
    return length;
  };
  if (der[at++] !== 0x30) throw new Error("bad RSA key");
  readLength();
  const ints: bigint[] = [];
  while (at < der.length && ints.length < 9) {
    if (der[at++] !== 0x02) throw new Error("bad RSA key");
    const length = readLength();
    ints.push(toBig(der.subarray(at, at + length)));
    at += length;
  }
  if (ints.length < 9) throw new Error("bad RSA key");
  const [, n, e, d, p, q, dp, dq, qinv] = ints;
  return { n, e, d, p, q, dp, dq, qinv, size: Math.ceil(n.toString(16).length / 2) };
}

function rsaPrivate(key: RSAKey, m: bigint): bigint {
  // Chinese remainder theorem: two half-size exponentiations.
  const m1 = modPow(m % key.p, key.dp, key.p);
  const m2 = modPow(m % key.q, key.dq, key.q);
  let h = (key.qinv * (m1 - m2)) % key.p;
  if (h < 0n) h += key.p;
  return m2 + h * key.q;
}

function mgf1(seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let counter = 0, at = 0; at < length; counter++) {
    const c = new Uint8Array([counter >>> 24, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255]);
    const block = sha1(concat(seed, c));
    out.set(block.subarray(0, Math.min(20, length - at)), at);
    at += 20;
  }
  return out;
}

/** RSASSA-PSS with SHA-1, MGF1 and a 20-byte salt. */
export function rsaPssSign(key: RSAKey, message: Uint8Array): Uint8Array {
  const emBits = key.n.toString(2).length - 1;
  const emLength = Math.ceil(emBits / 8);
  const salt = randomBytes(20);
  const h = sha1(concat(new Uint8Array(8), sha1(message), salt));
  const db = new Uint8Array(emLength - 21);
  db[db.length - 21] = 0x01;
  db.set(salt, db.length - 20);
  const mask = mgf1(h, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= mask[i];
  db[0] &= 0xff >> (8 * emLength - emBits);
  const em = concat(db, h, new Uint8Array([0xbc]));
  return fromBig(rsaPrivate(key, toBig(em)), key.size);
}

/** RSAES-OAEP with SHA-1 and MGF1, decrypting. */
export function rsaOaepDecrypt(key: RSAKey, cipher: Uint8Array): Uint8Array {
  const em = fromBig(rsaPrivate(key, toBig(cipher)), key.size);
  const maskedSeed = em.subarray(1, 21);
  const maskedDB = em.subarray(21);
  const seedMask = mgf1(maskedDB, 20);
  const seed = maskedSeed.map((b, i) => b ^ seedMask[i]);
  const dbMask = mgf1(seed, maskedDB.length);
  const db = maskedDB.map((b, i) => b ^ dbMask[i]);
  let i = 20;
  while (i < db.length && db[i] === 0) i++;
  if (em[0] !== 0 || db[i] !== 1) throw new Error("RSA-OAEP: decryption error");
  return db.subarray(i + 1);
}
