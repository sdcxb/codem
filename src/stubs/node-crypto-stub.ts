// Browser stub for Node.js crypto module
// Use browser-native crypto (Web Crypto API) instead
export const createHash = (algorithm: string) => ({
  update: function(_data: any) { return this },
  digest: (_encoding?: string): string => "",
})
export const randomUUID = (): string => crypto.randomUUID()
export const randomBytes = (size: number): Buffer => Buffer.alloc(size)
export default { createHash, randomUUID, randomBytes }
