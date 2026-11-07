// Widevine, in plain TypeScript: enough of a CDM to ask for a license and
// read the content keys out of it.

import { aesCbcDecrypt, aesCmac } from "./aes.ts";
import { concat, hex, randomBytes, utf8 } from "./bytes.ts";
import { loadDevice } from "./device.ts";
import { allBytesOf, bytesOf, decode, encode, numberOf } from "./protobuf.ts";
import { rsaOaepDecrypt, rsaPssSign } from "./rsa.ts";

export interface ContentKey {
  kid: Uint8Array;
  /** 2 for a content key. */
  type: number;
  key: Uint8Array;
}

export interface Session {
  /** The signed license request to send. */
  challenge: Uint8Array;
  /** The keys in the license that answers it. */
  parse(license: Uint8Array): ContentKey[];
}

function uint64LE(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** A license request for key ID kid, and how to read the license that answers it. */
export function widevineChallenge(kid: Uint8Array): Session {
  const { key, clientId } = loadDevice();
  // WidevinePsshData: the key ID.
  const psshData = encode([[2, kid.length > 16 ? kid.slice(-16) : kid]]);
  const requestId = concat(randomBytes(4), new Uint8Array(4), uint64LE(Date.now()));
  // ContentIdentification.WidevinePsshData: the PSSH data, STREAMING, the request ID.
  const widevinePssh = encode([
    [1, psshData],
    [2, 1],
    [3, utf8(hex(requestId).toUpperCase())],
  ]);
  const contentId = encode([[1, widevinePssh]]);
  const request = encode([
    [1, clientId],
    [2, contentId],
    [3, 1], // NEW
    [4, Math.floor(Date.now() / 1000)],
    [6, 21], // VERSION_2_1
    [7, Math.floor(Math.random() * 0xffffffff)],
  ]);
  const signed = encode([
    [1, 1], // LICENSE_REQUEST
    [2, request],
    [3, rsaPssSign(key, request)],
  ]);
  return {
    challenge: signed,
    parse(license) {
      const msg = decode(license);
      if (numberOf(msg, 1) !== 2) throw new Error("Widevine: the answer isn't a license");
      const sessionKeyCipher = bytesOf(msg, 4);
      const body = bytesOf(msg, 2);
      if (!sessionKeyCipher || !body) throw new Error("Widevine: the license has no keys");
      const sessionKey = rsaOaepDecrypt(key, sessionKeyCipher);
      const encryptionKey = aesCmac(
        sessionKey,
        concat(new Uint8Array([1]), utf8("ENCRYPTION"), new Uint8Array([0]), request, new Uint8Array([0, 0, 0, 0x80])),
      );
      return allBytesOf(decode(body), 3).map((raw) => {
        const k = decode(raw);
        const iv = bytesOf(k, 2);
        const encrypted = bytesOf(k, 3);
        return {
          kid: bytesOf(k, 1) ?? new Uint8Array(0),
          type: numberOf(k, 4) ?? 0,
          key: iv && encrypted ? aesCbcDecrypt(encryptionKey, iv, encrypted) : new Uint8Array(0),
        };
      });
    },
  };
}
