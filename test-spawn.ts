import { spawn } from "child_process";

const child = spawn("D:\\mimo\\mimo.exe", ["run", "--format", "json", "say hi"], {
  cwd: "D:\\mimo",
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, FORCE_COLOR: "0" },
});

console.log("PID:", child.pid);

child.stdout?.on("data", (chunk: Buffer) => {
  console.log("STDOUT chunk:", chunk.length, "bytes");
  console.log("STDOUT:", chunk.toString().substring(0, 500));
});

child.stderr?.on("data", (chunk: Buffer) => {
  console.log("STDERR:", chunk.toString().substring(0, 500));
});

child.on("close", (code, signal) => {
  console.log("CLOSED, code:", code, "signal:", signal);
});

child.on("error", (err) => {
  console.error("ERROR:", err.message);
});

setTimeout(() => {
  console.log("Timeout - killing");
  child.kill();
  process.exit(1);
}, 30000);
