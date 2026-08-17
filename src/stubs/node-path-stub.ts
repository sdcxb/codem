// Browser stub for Node.js path module
export const join = (...paths: string[]): string => paths.filter(Boolean).join("/")
export const resolve = (...paths: string[]): string => paths.filter(Boolean).join("/")
export const dirname = (p: string): string => p.split("/").slice(0, -1).join("/") || "/"
export const basename = (p: string, ext?: string): string => {
  const base = p.split("/").pop() || p
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base
}
export const extname = (p: string): string => {
  const base = basename(p)
  const idx = base.lastIndexOf(".")
  return idx >= 0 ? base.slice(idx) : ""
}
export const sep = "/"
export const delimiter = ":"
export const normalize = (p: string): string => p
export const relative = (from: string, to: string): string => to
export const isAbsolute = (p: string): boolean => p.startsWith("/")
export default { join, resolve, dirname, basename, extname, sep, delimiter, normalize, relative, isAbsolute }
