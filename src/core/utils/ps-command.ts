/**
 * PowerShell command-line argument quoting utilities.
 *
 * Codem executes native commands (git, mkdir, etc.) via the Tauri
 * `execute_command` bridge, which runs the whole string through
 * `powershell -Command ...`. Any argument containing PowerShell
 * metacharacters must be safely quoted, otherwise PowerShell interprets it:
 *   - `HEAD^{tree}`  → `{tree}` parsed as a scriptblock → "ScriptBlock should
 *     only be specified as a value of the Command parameter"
 *   - `$HOME`        → variable expansion
 *   - backticks      → escape character
 *   - `;` / `|` / `&` → command chaining / piping (injection risk)
 *
 * Rules (PowerShell quoting):
 *   - Single quotes make everything literal; embedded single quotes are
 *     doubled (`''`).
 *   - We prefer single quotes for any argument that contains characters
 *     outside a conservative safe set.
 */

/** Characters that are safe unquoted inside a PowerShell -Command argument list. */
const SAFE_UNQUOTED = /^[A-Za-z0-9_\-.:/\\=,]+$/;

/** Wrap an argument in PowerShell single quotes (literal). */
export function psQuote(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`;
}

/** Quote only when needed — keeps normal arguments readable. */
export function maybePsQuote(arg: string): string {
  if (!arg) return "''";
  if (SAFE_UNQUOTED.test(arg)) return arg;
  return psQuote(arg);
}

/**
 * Build a git command string safe for `powershell -Command`:
 *   git -C '<cwd>' <arg1> <arg2> ...
 * Every argument (including cwd) is quoted only when it contains
 * PowerShell metacharacters.
 */
export function buildGitCommand(cwd: string, args: string[]): string {
  return `git -C ${maybePsQuote(cwd)} ${args.map(maybePsQuote).join(" ")}`;
}
