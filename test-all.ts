import { WebSocket } from "ws";

const PASS = "\u2705";
const FAIL = "\u274c";
let passed = 0;
let failed = 0;

function test(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`${PASS} ${name}`); }
  else { failed++; console.log(`${FAIL} ${name}`); }
}

async function testFileAPI() {
  console.log("\n=== File API ===");
  try {
    const res = await fetch("http://localhost:3002/api/files?path=D:\\mimo-gui\\src");
    test("GET /api/files returns 200", res.ok);
    const files = await res.json();
    test("Returns array", Array.isArray(files));
    test("Has entries", files.length > 0);
    test("Entries have name/path/isDirectory", files[0]?.name && "isDirectory" in files[0]);
    console.log(`  Found ${files.length} entries: ${files.slice(0, 5).map((f: any) => f.name).join(", ")}...`);
  } catch (e: any) { test("File API reachable", false); console.log("  Error:", e.message); }
}

async function testFileContent() {
  console.log("\n=== File Content ===");
  try {
    const res = await fetch("http://localhost:3002/api/file?path=D:\\mimo-gui\\package.json");
    test("GET /api/file returns 200", res.ok);
    const text = await res.text();
    test("Returns content", text.includes("mimo-gui"));
    console.log(`  Content length: ${text.length} bytes`);
  } catch (e: any) { test("File content API", false); console.log("  Error:", e.message); }
}

async function testChat() {
  console.log("\n=== Chat ===");
  return new Promise<void>((resolve) => {
    const ws = new WebSocket("ws://localhost:3001");
    let gotStarted = false;
    let gotText = false;
    let gotDone = false;

    ws.on("open", () => {
      test("WebSocket connected", true);
      ws.send(JSON.stringify({ type: "start", message: "say hi", cwd: "D:\\mimo" }));
    });

    ws.on("message", (data) => {
      try {
        const e = JSON.parse(data.toString());
        if (e.type === "started") gotStarted = true;
        if (e.type === "text") { gotText = true; console.log(`  Response: ${e.part?.text?.substring(0, 80)}`); }
        if (e.type === "done") {
          gotDone = true;
          test("Got 'started' event", gotStarted);
          test("Got 'text' event", gotText);
          test("Got 'done' event", gotDone);
          ws.close();
          resolve();
        }
      } catch {}
    });

    ws.on("error", (err) => { test("Chat WebSocket", false); console.log("  Error:", err.message); ws.close(); resolve(); });
    setTimeout(() => { test("Chat timeout", false); ws.close(); resolve(); }, 45000);
  });
}

async function testTerminal() {
  console.log("\n=== Terminal ===");
  return new Promise<void>((resolve) => {
    const ws = new WebSocket("ws://localhost:3001");
    let gotData = false;

    ws.on("open", () => {
      test("Terminal WebSocket connected", true);
      ws.send(JSON.stringify({ type: "terminal:start", cwd: "D:\\mimo-gui" }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "terminal:input", data: "echo hello-from-test\r" }));
      }, 500);
    });

    ws.on("message", (data) => {
      try {
        const e = JSON.parse(data.toString());
        if (e.type === "terminal:data") {
          if (e.data.includes("hello-from-test")) {
            gotData = true;
            test("Terminal echo works", true);
            console.log(`  Got: ${e.data.substring(0, 100).replace(/\n/g, "\\n")}`);
            ws.close();
            resolve();
          }
        }
      } catch {}
    });

    ws.on("error", () => { test("Terminal", false); ws.close(); resolve(); });
    setTimeout(() => { test("Terminal timeout", false); ws.close(); resolve(); }, 10000);
  });
}

async function testToolUse() {
  console.log("\n=== Tool Use ===");
  return new Promise<void>((resolve) => {
    const ws = new WebSocket("ws://localhost:3001");
    let gotToolUse = false;

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "start", message: "read D:\\mimo-gui\\package.json", cwd: "D:\\mimo-gui" }));
    });

    ws.on("message", (data) => {
      try {
        const e = JSON.parse(data.toString());
        if (e.type === "tool_use") {
          gotToolUse = true;
          test("Got tool_use event", true);
          console.log(`  Tool: ${e.part?.tool}, CallID: ${e.part?.callID?.substring(0, 20)}...`);
        }
        if (e.type === "done") {
          test("Got tool_use", gotToolUse);
          ws.close();
          resolve();
        }
      } catch {}
    });

    ws.on("error", () => { test("Tool use", false); ws.close(); resolve(); });
    setTimeout(() => { test("Tool use timeout", false); ws.close(); resolve(); }, 60000);
  });
}

console.log("🧪 MiMoCode GUI Test Suite\n");

await testFileAPI();
await testFileContent();
await testChat();
await testTerminal();
await testToolUse();

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
