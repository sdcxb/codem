// @ts-nocheck
/**
 * Browser polyfill for Node.js Buffer.
 *
 * Provides the subset of Buffer APIs used in this project:
 * - Buffer.byteLength(str, encoding) — UTF-8 byte length of a string
 * - Buffer.from(str, encoding) — create buffer from string (utf8/base64/hex)
 * - Buffer.from(arraybuffer) — create buffer from ArrayBuffer
 * - buf.subarray(start, end) — subarray
 * - buf.length — byte length
 * - buf[i] — byte access
 * - buf.toString(encoding) — decode (utf8/base64/hex)
 *
 * Uses Web APIs (TextEncoder/TextDecoder, btoa/atob) internally.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeBase64(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decodeHex(str: string): Uint8Array {
  const len = str.length % 2 === 0 ? str.length : str.length - 1;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = parseInt(str.substring(i, i + 2), 16);
  }
  return bytes;
}

function encodeHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function encodeInput(input: string, encoding?: string): Uint8Array {
  const enc = (encoding || "utf8").toLowerCase();
  if (enc === "utf8" || enc === "utf-8") {
    return encoder.encode(input);
  }
  if (enc === "base64") {
    return decodeBase64(input);
  }
  if (enc === "hex") {
    return decodeHex(input);
  }
  // Default to utf8
  return encoder.encode(input);
}

function decodeBytes(bytes: Uint8Array, encoding?: string): string {
  const enc = (encoding || "utf8").toLowerCase();
  if (enc === "utf8" || enc === "utf-8") {
    return decoder.decode(bytes);
  }
  if (enc === "base64") {
    return encodeBase64(bytes);
  }
  if (enc === "hex") {
    return encodeHex(bytes);
  }
  // Default to utf8
  return decoder.decode(bytes);
}

class BufferPolyfill extends Uint8Array {
  static byteLength(str: string, encoding?: string): number {
    return encodeInput(str, encoding).length;
  }

  static from(input: string | ArrayBuffer | Uint8Array | number[], encoding?: string): BufferPolyfill {
    if (typeof input === "string") {
      const bytes = encodeInput(input, encoding);
      const buf = new BufferPolyfill(bytes.length);
      buf.set(bytes);
      return buf;
    }
    if (input instanceof ArrayBuffer) {
      return new BufferPolyfill(input);
    }
    if (input instanceof Uint8Array) {
      const buf = new BufferPolyfill(input.length);
      buf.set(input);
      return buf;
    }
    if (Array.isArray(input)) {
      const buf = new BufferPolyfill(input.length);
      buf.set(input);
      return buf;
    }
    throw new TypeError(`Buffer.from: unsupported input type ${typeof input}`);
  }

  toString(encoding?: string): string {
    return decodeBytes(this, encoding);
  }

  subarray(start?: number, end?: number): BufferPolyfill {
    return super.subarray(start, end) as BufferPolyfill;
  }
}

const Buffer = BufferPolyfill as any;

export default Buffer;
export { Buffer };
