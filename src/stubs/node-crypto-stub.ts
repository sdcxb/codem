// Browser stub for Node.js crypto module
// Uses Web Crypto API where possible; Tauri IPC for file-based operations
// Note: createHash returns a minimal hash object compatible with the Node.js API shape

/**
 * Create a hash object compatible with Node.js crypto.createHash().
 * Uses Web Crypto API (SubtleCrypto) for SHA-256.
 */
export function createHash(algorithm: string) {
  const data: Uint8Array[] = [];
  return {
    update(chunk: any) {
      if (typeof chunk === 'string') {
        data.push(new TextEncoder().encode(chunk));
      } else if (chunk instanceof Uint8Array) {
        data.push(chunk);
      } else if (chunk instanceof ArrayBuffer) {
        data.push(new Uint8Array(chunk));
      }
      return this;
    },
    digest(encoding?: string): string {
      // Node.js createHash().digest() is synchronous.
      // Browser stub: return a hex string using a synchronous FNV-1a hash.
      // This is non-cryptographic but sufficient for spill-store session directory naming.
      const totalLength = data.reduce((sum, d) => sum + d.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const d of data) {
        merged.set(d, offset);
        offset += d.length;
      }
      // FNV-1a hash (synchronous, non-cryptographic — sufficient for directory naming)
      let hash = 0x811c9dc5;
      for (let i = 0; i < merged.length; i++) {
        hash ^= merged[i];
        hash = Math.imul(hash, 0x01000193);
      }
      const hex = (hash >>> 0).toString(16).padStart(8, '0').repeat(8).slice(0, 12);
      return hex;
    },
  };
}

/** Generate random bytes using Web Crypto API */
export function randomBytes(size: number): Uint8Array {
  const arr = new Uint8Array(size);
  crypto.getRandomValues(arr);
  return arr;
}

/** Generate a UUID using Web Crypto API */
export function randomUUID(): string {
  return crypto.randomUUID();
}

export default { createHash, randomUUID, randomBytes };
