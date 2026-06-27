import { WebSocket } from "ws";

const ws = new WebSocket("ws://localhost:3001");

ws.on("open", () => {
  console.log("Connected to server");
  const msg = JSON.stringify({ type: "start", message: "say hello", cwd: "D:\\mimo" });
  console.log("Sending:", msg);
  ws.send(msg);
});

ws.on("message", (data) => {
  const text = data.toString();
  console.log("←", text.substring(0, 300));
  try {
    const e = JSON.parse(text);
    if (e.type === "done" || e.type === "step_finish") {
      console.log("Response complete, closing");
      setTimeout(() => ws.close(), 500);
    }
  } catch {}
});

ws.on("close", () => {
  console.log("Connection closed");
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log("Timeout - forcing exit");
  process.exit(1);
}, 60000);
