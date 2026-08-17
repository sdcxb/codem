// Browser stub for Node.js os module
export const homedir = (): string => ""
export const platform = (): string => "browser"
export const tmpdir = (): string => "/tmp"
export const userInfo = (): any => ({ username: "user", homedir: "" })
export const hostname = (): string => "localhost"
export const cpus = (): any[] => []
export const totalmem = (): number => 0
export const freemem = (): number => 0
export const networkInterfaces = (): any => ({})
export const EOL = "\n"
export default { homedir, platform, tmpdir, userInfo, hostname, cpus, totalmem, freemem, networkInterfaces, EOL }
