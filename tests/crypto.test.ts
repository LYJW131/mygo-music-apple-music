// The Widevine CDM's cryptography, checked against Node's own.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { aesCbcDecrypt, aesCmac } from "../src/widevine/aes.ts";
import { b64decode, b64encode } from "../src/widevine/bytes.ts";
import { widevineChallenge } from "../src/widevine/cdm.ts";
import { WVD } from "../src/widevine/device.ts";
import { sha1 } from "../src/widevine/sha1.ts";

const bytes = (b: Buffer): Uint8Array => new Uint8Array(b);

test("base64 both ways", () => {
  for (let n = 0; n < 40; n++) {
    const data = crypto.randomBytes(n);
    assert.equal(b64encode(bytes(data)), data.toString("base64"));
    assert.deepEqual(Buffer.from(b64decode(data.toString("base64"))), data);
    assert.deepEqual(Buffer.from(b64decode(data.toString("base64url"))), data);
  }
});

test("SHA-1", () => {
  for (let n = 0; n < 50; n++) {
    const data = crypto.randomBytes(n * 7);
    assert.deepEqual(Buffer.from(sha1(bytes(data))), crypto.createHash("sha1").update(data).digest());
  }
});

test("AES-128-CBC", () => {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  for (const length of [1, 15, 16, 17, 100]) {
    const plain = crypto.randomBytes(length);
    const c = crypto.createCipheriv("aes-128-cbc", key, iv);
    const encrypted = Buffer.concat([c.update(plain), c.final()]);
    assert.deepEqual(Buffer.from(aesCbcDecrypt(bytes(key), bytes(iv), bytes(encrypted))), plain);
  }
});

test("AES-CMAC, RFC 4493's examples", () => {
  const key = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
  const msg = Buffer.from(
    "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710",
    "hex",
  );
  const want: Record<number, string> = {
    0: "bb1d6929e95937287fa37d129b756746",
    16: "070a16b46b4d4144f79bdd9dd04a287c",
    40: "dfa66747de9ae63030ca32611497c827",
    64: "51f0bebf7e3b9d92fc49741779363cfe",
  };
  for (const [length, mac] of Object.entries(want)) {
    assert.equal(Buffer.from(aesCmac(bytes(key), bytes(msg.subarray(0, +length)))).toString("hex"), mac);
  }
});

// The device's key, read the way Node reads one.
const raw = Buffer.from(WVD, "base64");
const keyLength = raw.readUInt16BE(7);
const privateKey = crypto.createPrivateKey({ key: raw.subarray(9, 9 + keyLength), format: "der", type: "pkcs1" });
const publicKey = crypto.createPublicKey(privateKey);

// A protobuf message's fields, read independently of the plugin's reader.
function fields(b: Uint8Array): Record<number, (number | Uint8Array)[]> {
  const out: Record<number, (number | Uint8Array)[]> = {};
  let at = 0;
  const varint = (): bigint => {
    let r = 0n;
    for (let s = 0n; ; s += 7n) {
      const x = b[at++];
      r |= BigInt(x & 0x7f) << s;
      if (!(x & 0x80)) return r;
    }
  };
  while (at < b.length) {
    const tag = Number(varint());
    if ((tag & 7) === 0) (out[tag >> 3] ??= []).push(Number(varint()));
    else {
      const length = Number(varint());
      (out[tag >> 3] ??= []).push(b.subarray(at, at + length));
      at += length;
    }
  }
  return out;
}

const field = (f: number, v: Buffer): Buffer => {
  const length: number[] = [];
  let n = v.length;
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    length.push(b);
  } while (n);
  return Buffer.concat([Buffer.from([(f << 3) | 2, ...length]), v]);
};
const small = (f: number, v: number): Buffer => Buffer.from([f << 3, v]);

test("a license request signed with RSA-PSS, and a license read with RSA-OAEP", () => {
  const kid = bytes(crypto.randomBytes(16));
  const session = widevineChallenge(kid);
  // The challenge is a SignedMessage: 1 type, 2 msg, 3 signature.
  const signed = fields(session.challenge);
  assert.equal(signed[1][0], 1);
  const request = signed[2][0] as Uint8Array;
  assert.ok(
    crypto.verify(
      "sha1",
      request,
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 20 },
      signed[3][0] as Uint8Array,
    ),
  );

  // A license as a server would make it: the session key under OAEP, the
  // content key under the key derived from the request.
  const sessionKey = crypto.randomBytes(16);
  const contentKey = crypto.randomBytes(16);
  const context = Buffer.concat([Buffer.from([1]), Buffer.from("ENCRYPTION\0"), request, Buffer.from([0, 0, 0, 0x80])]);
  const encryptionKey = Buffer.from(aesCmac(bytes(sessionKey), bytes(context)));
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-128-cbc", encryptionKey, iv);
  const container = Buffer.concat([
    field(1, Buffer.from(kid)),
    field(2, iv),
    field(3, Buffer.concat([c.update(contentKey), c.final()])),
    small(4, 2),
  ]);
  const wrapped = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    sessionKey,
  );
  const license = Buffer.concat([small(1, 2), field(2, field(3, container)), field(4, wrapped)]);
  const keys = session.parse(bytes(license));
  assert.equal(keys.length, 1);
  assert.equal(keys[0].type, 2);
  assert.deepEqual(Buffer.from(keys[0].key), contentKey);
  assert.deepEqual(keys[0].kid, kid);
});
