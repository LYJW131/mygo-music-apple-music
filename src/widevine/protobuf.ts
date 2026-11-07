// Just enough of protocol buffers for Widevine's messages, without their
// schema: fields by number.

import { concat, utf8 } from "./bytes.ts";

export type FieldValue = number | bigint | string | Uint8Array | undefined | null;

/** A message's fields, each a list of its values: numbers for varints, bytes for the rest. */
export type Fields = Record<number, (number | Uint8Array)[] | undefined>;

export function varint(n: number | bigint): Uint8Array {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return new Uint8Array(out);
}

/** A message from [field, value] pairs: numbers are varints, the rest length-delimited. */
export function encode(fields: [number, FieldValue][]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [field, value] of fields) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number" || typeof value === "bigint") {
      parts.push(varint(field << 3), varint(value));
    } else {
      const bytes = typeof value === "string" ? utf8(value) : value;
      parts.push(varint((field << 3) | 2), varint(bytes.length), bytes);
    }
  }
  return concat(...parts);
}

export function decode(bytes: Uint8Array): Fields {
  const fields: Fields = {};
  let at = 0;
  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = bytes[at++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  };
  while (at < bytes.length) {
    const tag = Number(readVarint());
    const field = tag >> 3;
    let value: number | Uint8Array;
    switch (tag & 7) {
      case 0:
        value = Number(readVarint());
        break;
      case 1:
        value = bytes.subarray(at, at + 8);
        at += 8;
        break;
      case 2: {
        const length = Number(readVarint());
        value = bytes.subarray(at, at + length);
        at += length;
        break;
      }
      case 5:
        value = bytes.subarray(at, at + 4);
        at += 4;
        break;
      default:
        throw new Error("protobuf: unknown wire type");
    }
    (fields[field] ??= []).push(value);
  }
  return fields;
}

/** The field's first value, if it's a number. */
export function numberOf(fields: Fields, field: number): number | undefined {
  const v = fields[field]?.[0];
  return typeof v === "number" ? v : undefined;
}

/** The field's first value, if it's bytes. */
export function bytesOf(fields: Fields, field: number): Uint8Array | undefined {
  const v = fields[field]?.[0];
  return v instanceof Uint8Array ? v : undefined;
}

/** All of the field's values that are bytes. */
export function allBytesOf(fields: Fields, field: number): Uint8Array[] {
  return (fields[field] ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array);
}
