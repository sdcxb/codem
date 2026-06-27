import { build } from "esbuild";
import { execSync } from "child_process";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";

const outdir = join(process.cwd(), "dist-server");
const outFile = join(outdir, "server.mjs");

// Step 1: Bundle server.ts with esbuild
console.log("[1/2] Bundling server.ts...");
await build({
  entryPoints: ["server.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: outFile,
  external: ["node-pty"],
});
console.log(`  → ${outFile}`);

// Step 2: Compile to standalone exe with pkg
console.log("[2/2] Compiling to standalone executable...");

const binariesDir = join(process.cwd(), "src-tauri", "binaries");
if (!existsSync(binariesDir)) {
  mkdirSync(binariesDir, { recursive: true });
}

// Detect target triple
const platform = process.platform;
const arch = process.arch;
const triples = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};
const triple = triples[`${platform}-${arch}`] || "x86_64-pc-windows-msvc";
const ext = platform === "win32" ? ".exe" : "";
const targetName = `server-${triple}${ext}`;

try {
  execSync(
    `npx pkg ${outFile} --target node20-${platform === "win32" ? "win" : platform === "darwin" ? "macos" : "linux"}-${arch === "arm64" ? "arm64" : "x64"} --output "${join(binariesDir, targetName)}"`,
    { stdio: "inherit" }
  );
  console.log(`  → ${join(binariesDir, targetName)}`);
  console.log("Done! Sidecar ready for Tauri.");
} catch (e) {
  console.error("pkg compilation failed:", e.message);
  console.log("\nFalling back to node script mode...");
  // Create a launcher script instead
  const launcherExt = platform === "win32" ? ".cmd" : ".sh";
  const launcherName = `server-${triple}${launcherExt}`;
  const launcherPath = join(binariesDir, launcherName);

  if (platform === "win32") {
    const { writeFileSync } = await import("fs");
    writeFileSync(
      launcherPath,
      `@echo off\nnode "${join(process.cwd(), "dist-server", "server.mjs")}" %*\n`
    );
  } else {
    const { writeFileSync } = await import("fs");
    writeFileSync(
      launcherPath,
      `#!/bin/sh\nnode "${join(process.cwd(), "dist-server", "server.mjs")}" "$@"\n`
    );
  }
  console.log(`  → Created launcher: ${launcherPath}`);
}
