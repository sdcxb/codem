import { spawn, ChildProcess } from "child_process";
import { WebSocketServer, WebSocket } from "ws";
import { readdir, stat, readFile, writeFile, mkdir, copyFile } from "fs/promises";
import { join, extname, dirname, basename } from "path";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ========== Simple Glob Implementation ==========
async function simpleGlob(pattern: string, basePath: string): Promise<string[]> {
  const results: string[] = [];
  const patternParts = pattern.split(/[/\\]/);

  async function walk(dir: string, partIdx: number) {
    if (partIdx >= patternParts.length) return;
    const part = patternParts[partIdx];
    const isLast = partIdx === patternParts.length - 1;

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;

        const fullPath = join(dir, entry.name);
        const matches = entry.isDirectory()
          ? part === "**" || matchPattern(entry.name, part)
          : (isLast || part === "**") && matchPattern(entry.name, part);

        if (entry.isDirectory()) {
          if (part === "**") {
            await walk(fullPath, partIdx);
            if (isLast) results.push(fullPath);
            await walk(fullPath, partIdx + 1);
          } else if (matchPattern(entry.name, part)) {
            await walk(fullPath, partIdx + 1);
          }
        } else if (matches) {
          results.push(fullPath);
        }
      }
    } catch {}
  }

  await walk(basePath, 0);
  return results;
}

function matchPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === "**") return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return name === pattern;

  const regex = new RegExp(
    "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return regex.test(name);
}

const MIMO_PATH = process.env.MIMO_PATH || "D:\\mimo\\mimo.exe";
const WS_PORT = parseInt(process.env.PORT || "3001");
const API_PORT = parseInt(process.env.API_PORT || "3002");

// ========== WebSocket Server (Chat + Terminal) ==========
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`WebSocket server on ws://localhost:${WS_PORT}`);

const activeChildren = new Map<WebSocket, ChildProcess>();
const terminalChildren = new Map<WebSocket, ChildProcess>();

wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected");

  ws.on("message", (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      // ---- Chat messages ----
      if (msg.type === "start") {
        const existing = activeChildren.get(ws);
        if (existing) { existing.kill(); activeChildren.delete(ws); }

        const cwd = msg.cwd || "D:\\mimo";
        const model = msg.model || "mimo/mimo-auto";
        const sessionId = msg.sessionId;

        // Build mimo command args
        const args = ["run", "--format", "json", "-m", model];
        if (sessionId) {
          args.push("--session", sessionId);
        }
        args.push(msg.message);

        const child = spawn(MIMO_PATH, args, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
        activeChildren.set(ws, child);
        child.stdin?.end();

        let buf = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (line.trim() && ws.readyState === WebSocket.OPEN) ws.send(line.trim());
          }
        });
        child.stdout?.on("end", () => {
          if (buf.trim() && ws.readyState === WebSocket.OPEN) ws.send(buf.trim());
        });
        child.stderr?.on("data", (c: Buffer) => console.log("stderr:", c.toString().substring(0, 100)));
        child.on("close", (code) => {
          activeChildren.delete(ws);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "done", exitCode: code }));
        });
        child.on("error", (err) => {
          activeChildren.delete(ws);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", message: err.message }));
        });
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "started" }));
      }

      // ---- Terminal messages (PTY) ----
      else if (msg.type === "terminal:start") {
        const existing = terminalChildren.get(ws);
        if (existing) { existing.kill(); terminalChildren.delete(ws); }

        const cwd = msg.cwd || "D:\\mimo";
        let child: ChildProcess;

        // Try node-pty first, fallback to basic spawn
        try {
          const pty = require("node-pty");
          const shell = process.platform === "win32" ? "powershell.exe" : "bash";
          const ptyProcess = pty.spawn(shell, [], {
            name: "xterm-256color",
            cols: msg.cols || 80,
            rows: msg.rows || 24,
            cwd,
            env: process.env as Record<string, string>,
          });

          ptyProcess.onData((data: string) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "terminal:data", data }));
            }
          });

          ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
            terminalChildren.delete(ws);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "terminal:data", data: `\r\n[进程退出 code=${exitCode}]\r\n` }));
            }
          });

          // Store a wrapper with stdin.write and kill
          const wrapper = {
            stdin: { write: (data: string) => ptyProcess.write(data) },
            kill: () => ptyProcess.kill(),
          } as any;
          terminalChildren.set(ws, wrapper);

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "terminal:data", data: "\r\n🔗 已连接到 MiMoCode 终端 (PTY)\r\n" }));
          }
        } catch {
          // Fallback: basic spawn
          const shell = process.platform === "win32" ? "powershell.exe" : "bash";
          child = spawn(shell, [], { cwd, stdio: ["pipe", "pipe", "pipe"] });
          terminalChildren.set(ws, child);

          child.stdout?.on("data", (chunk: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "terminal:data", data: chunk.toString() }));
            }
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "terminal:data", data: chunk.toString() }));
            }
          });
          child.on("close", (code) => {
            terminalChildren.delete(ws);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "terminal:data", data: `\r\n[进程退出 code=${code}]\r\n` }));
            }
          });
        }
      }

      else if (msg.type === "terminal:input") {
        const child = terminalChildren.get(ws);
        if (child?.stdin) child.stdin.write(msg.data);
      }

      else if (msg.type === "terminal:resize") {
        const child = terminalChildren.get(ws) as any;
        if (child?.resize) {
          try { child.resize(msg.cols, msg.rows); } catch {}
        }
      }

      else if (msg.type === "cancel") {
        const child = activeChildren.get(ws);
        if (child) { child.kill(); activeChildren.delete(ws); }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "cancelled" }));
      }

    } catch (err) {
      console.error("Parse error:", err);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    const chatChild = activeChildren.get(ws);
    if (chatChild) { chatChild.kill(); activeChildren.delete(ws); }
    const termChild = terminalChildren.get(ws);
    if (termChild) { termChild.kill(); terminalChildren.delete(ws); }
  });
});

// ========== Multipart Parser ==========
function parseMultipart(buffer: Buffer, boundary: string): Array<{ filename: string; contentType: string; data: Buffer }> {
  const results: Array<{ filename: string; contentType: string; data: Buffer }> = [];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);

  let start = buffer.indexOf(boundaryBuf) + boundaryBuf.length + 2; // skip \r\n
  while (start < buffer.length) {
    const end = buffer.indexOf(boundaryBuf, start);
    if (end === -1) break;

    const part = buffer.slice(start, end - 2); // -2 for \r\n before boundary
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) { start = end + boundaryBuf.length + 2; continue; }

    const headers = part.slice(0, headerEnd).toString();
    const body = part.slice(headerEnd + 4);

    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const contentTypeMatch = headers.match(/Content-Type:\s*(.+)/i);

    if (filenameMatch) {
      results.push({
        filename: filenameMatch[1],
        contentType: contentTypeMatch?.[1]?.trim() || "application/octet-stream",
        data: body,
      });
    }

    start = end + boundaryBuf.length + 2;
  }
  return results;
}

// ========== HTTP Server (File API) ==========
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url || "/", `http://localhost:${API_PORT}`);

  if (req.method === "GET") {
    if (url.pathname === "/api/files") {
      const dirPath = url.searchParams.get("path") || "D:\\mimo";
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        const result = entries
          .filter((e) => e.name !== "node_modules" && !e.name.startsWith("."))
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          })
          .map((e) => ({
            name: e.name,
            path: join(dirPath, e.name),
            isDirectory: e.isDirectory(),
          }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === "/api/file") {
      const filePath = url.searchParams.get("path");
      if (!filePath) { res.writeHead(400); res.end("Missing path"); return; }
      try {
        const content = await readFile(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(content);
      } catch (err: any) {
        res.writeHead(500); res.end(err.message);
      }
    } else if (url.pathname === "/api/file-preview") {
      const filePath = url.searchParams.get("path");
      if (!filePath) { res.writeHead(400); res.end("Missing path"); return; }
      try {
        const content = await readFile(filePath, "utf-8");
        const truncated = content.length > 50000 ? content.substring(0, 50000) + "\n...(truncated)" : content;
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(truncated);
      } catch (err: any) {
        res.writeHead(500); res.end(err.message);
      }
    } else if (url.pathname === "/api/glob") {
      const pattern = url.searchParams.get("pattern");
      const searchPath = url.searchParams.get("path") || ".";
      if (!pattern) { res.writeHead(400); res.end("Missing pattern"); return; }
      try {
        const files = await simpleGlob(pattern, searchPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ files }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === "/api/grep") {
      const pattern = url.searchParams.get("pattern");
      const searchPath = url.searchParams.get("path") || ".";
      const include = url.searchParams.get("include");
      if (!pattern) { res.writeHead(400); res.end("Missing pattern"); return; }
      try {
        const includeArg = include ? `--include="${include}"` : "";
        const cmd = `grep -rn "${pattern}" ${includeArg} "${searchPath}" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -100`;
        const { stdout } = await execAsync(cmd);
        const results = stdout.trim().split("\n").filter(Boolean);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results }));
      } catch (err: any) {
        // grep returns exit code 1 when no matches found
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
      }
    } else if (url.pathname === "/api/upload") {
      // Parse multipart form data manually for simplicity
      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("multipart/form-data")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Expected multipart/form-data" }));
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        try {
          const buffer = Buffer.concat(chunks);
          const boundary = contentType.split("boundary=")[1];
          if (!boundary) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing boundary" }));
            return;
          }

          // Simple multipart parser
          const parts = parseMultipart(buffer, boundary);
          if (parts.length === 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No files found" }));
            return;
          }

          const uploadDir = join(process.cwd(), ".mimo-uploads");
          await mkdir(uploadDir, { recursive: true });

          const results = [];
          for (const part of parts) {
            const ext = extname(part.filename);
            const newName = `${randomUUID()}${ext}`;
            const destPath = join(uploadDir, newName);
            await writeFile(destPath, part.data);

            results.push({
              id: randomUUID(),
              name: part.filename,
              path: destPath,
              mimeType: part.contentType,
              size: part.data.length,
            });
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ files: results }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    } else {
      res.writeHead(404); res.end("Not found");
    }
    return;
  }

  if (req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));

      if (url.pathname === "/api/mkdir") {
        await mkdir(body.path, { recursive: true });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));

      } else if (url.pathname === "/api/write-file") {
        await mkdir(dirname(body.path), { recursive: true });
        await writeFile(body.path, body.content, "utf-8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));

      } else if (url.pathname === "/api/rename") {
        const { rename } = await import("fs/promises");
        await rename(body.oldPath, body.newPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));

      } else if (url.pathname === "/api/delete") {
        const { rm } = await import("fs/promises");
        await rm(body.path, { recursive: true, force: true });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));

      } else if (url.pathname === "/api/bash") {
        const command = body.command;
        const cwd = body.cwd || process.cwd();
        if (!command) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing command" }));
          return;
        }
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            env: { ...process.env, FORCE_COLOR: "0" },
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ stdout, stderr }));
        } catch (err: any) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            stdout: err.stdout || "",
            stderr: err.stderr || err.message,
          }));
        }

      } else if (url.pathname === "/api/mcp-stdio-connect") {
        // MCP stdio connection - spawn child process
        const { name, command, args, env } = body;
        if (!command) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing command" }));
          return;
        }

        try {
          const child = spawn(command, args || [], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...env },
          });

          // Store the child process for later communication
          if (!globalThis.mcpProcesses) {
            globalThis.mcpProcesses = new Map();
          }
          globalThis.mcpProcesses.set(name, child);

          child.on("error", (err) => {
            console.error(`[MCP] Process ${name} error:`, err.message);
            globalThis.mcpProcesses?.delete(name);
          });

          child.on("close", () => {
            globalThis.mcpProcesses?.delete(name);
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, pid: child.pid }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }

      } else {
        res.writeHead(404); res.end("Not found");
      }
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(405); res.end("Method not allowed");
});

httpServer.listen(API_PORT, () => {
  console.log(`HTTP API on http://localhost:${API_PORT}`);
});
