// Browser stub for Node.js fs module
// In Tauri, file operations are handled via Tauri IPC (invoke)
export const existsSync = (_path: string): boolean => false
export const mkdirSync = (_path: string, _opts?: any): void => {}
export const writeFileSync = (_path: string, _data: any, _opts?: any): void => {}
export const readFileSync = (_path: string, _opts?: any): string => ""
export const readdirSync = (_path: string): string[] => []
export const unlinkSync = (_path: string): void => {}
export const statSync = (_path: string): any => ({})
export const promises = {
  readFile: async (_path: string, _opts?: any): Promise<string> => "",
  writeFile: async (_path: string, _data: any, _opts?: any): Promise<void> => {},
  mkdir: async (_path: string, _opts?: any): Promise<void> => {},
  readdir: async (_path: string): Promise<string[]> => [],
  stat: async (_path: string): Promise<any> => ({}),
  exists: async (_path: string): Promise<boolean> => false,
  unlink: async (_path: string): Promise<void> => {},
}
export default { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync, promises }
