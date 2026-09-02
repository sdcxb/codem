/**
 * @deprecated R3-Audit: This seam provider is deprecated and unreferenced.
 * Use src/core/provider/shell-provider.ts instead.
 *
 * LocalShellProvider — Default Shell Seam Provider
 *
 * S0-3: Implements the ShellSeam interface using the local file-api's
 * executeCommand. A sandboxed provider could be swapped in by registering
 * a different provider for the "shell" seam.
 */

import type { ShellSeam } from "./types";

export class LocalShellProvider implements ShellSeam {
  readonly id = "local-shell";

  isAvailable(): boolean {
    return true;
  }

  async execute(
    command: string,
    cwd: string,
    _timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { executeCommand } = await import("../file-api");
    const result = await executeCommand(command, cwd, _timeoutMs);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 0,
    };
  }
}
