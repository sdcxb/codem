import { spawn } from "child_process";

// Try with shell: true
const child = spawn("D:\\mimo\\mimo.exe", ["run", "--format", "json", "say hi"], {
  cwd: "D:\\mimo",
  stdio: ["pipe", "pipe", "pipe"],
  shell: true,
});

console.log("PID:", child.pid);

child.stdout?.on("data", (chunk: Buffer) => {
  console.log("STDOUT:", chunk.toString().substring(0, 500));
});

child.stderr?.on("data", (chunk: Buffer) => {
  console.log("STDERR:", chunk.toString().substring(0, 500));
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
