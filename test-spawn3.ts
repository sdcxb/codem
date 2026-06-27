import { spawn } from "child_process";

// Try closing stdin immediately
const child = spawn("D:\\mimo\\mimo.exe", ["run", "--format", "json", "say hi"], {
  cwd: "D:\\mimo",
  stdio: ["pipe", "pipe", "pipe"],
});

console.log("PID:", child.pid);

// Close stdin immediately - mimo might be waiting for input
child.stdin?.end();

child.stdout?.on("data", (chunk: Buffer) => {
  console.log("STDOUT:", chunk.toString());
});

child.stderr?.on("data", (chunk: Buffer) => {
  console.log("STDERR:", chunk.toString().substring(0, 200));
});

child.on("close", (code, signal) => {
  console.log("CLOSED, code:", code, "signal:", signal);
  process.exit(0);
});

child.on("error", (err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log("Timeout");
  child.kill();
  process.exit(1);
}, 30000);
