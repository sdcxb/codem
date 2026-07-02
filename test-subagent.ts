// Sub-agent system test cases
// Run in browser console (Ctrl+Shift+I in Codem)

async function testSubagentSystem() {
  const results = [];
  const log = (msg: string) => { results.push(msg); console.log(msg); };

  // Test 1: SubagentManager exists
  log("=== Test 1: SubagentManager ===");
  try {
    const { getSubagentManager } = await import("./src/core/subagent/subagent");
    const manager = getSubagentManager();
    log(`✅ SubagentManager exists, tasks: ${manager.getAllTasks().length}`);
  } catch (e) {
    log(`❌ ${e}`);
    return results.join("\n");
  }

  // Test 2: Tools registered
  log("\n=== Test 2: Tools registered ===");
  try {
    const { getLLMEngine } = await import("./src/core/llm");
    const engine = getLLMEngine();
    const tools = engine.tools.getAll();
    const toolNames = tools.map((t: any) => t.id);
    log(`Tools: ${toolNames.join(", ")}`);
    log(toolNames.includes("spawn_subagent") ? "✅ spawn_subagent registered" : "❌ spawn_subagent missing");
    log(toolNames.includes("wait_for_subagent") ? "✅ wait_for_subagent registered" : "❌ wait_for_subagent missing");
  } catch (e) {
    log(`❌ ${e}`);
  }

  // Test 3: Spawn subagent
  log("\n=== Test 3: Spawn subagent ===");
  try {
    const { getSubagentManager } = await import("./src/core/subagent/subagent");
    const manager = getSubagentManager();
    const task = await manager.spawn("test-session", "general", "Say hello", ".", 30000, false);
    log(`✅ Spawned: ${task.id}, status: ${task.status}, persistent: ${task.persistent}`);
    
    // Test 4: Wait for completion
    log("\n=== Test 4: Wait for completion ===");
    const result = await manager.waitForCompletion(task.id, 60000);
    log(`✅ Completed: ${result.status}, summary: ${result.summary}`);
  } catch (e) {
    log(`❌ ${e}`);
  }

  // Test 5: Persistent subagent
  log("\n=== Test 5: Persistent subagent ===");
  try {
    const { getSubagentManager } = await import("./src/core/subagent/subagent");
    const manager = getSubagentManager();
    const task = await manager.spawn("test-session", "general", "Persistent test", ".", 30000, true);
    log(`✅ Persistent agent: ${task.id}, persistent: ${task.persistent}`);
    
    const tasks = manager.getAllTasks();
    const persistentCount = tasks.filter(t => t.persistent).length;
    log(`✅ Total tasks: ${tasks.length}, persistent: ${persistentCount}`);
  } catch (e) {
    log(`❌ ${e}`);
  }

  // Summary
  const passed = results.filter(r => r.startsWith("✅")).length;
  const failed = results.filter(r => r.startsWith("❌")).length;
  log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  return results.join("\n");
}

// Export for use
(window as any).testSubagentSystem = testSubagentSystem;
console.log("Test loaded. Run: testSubagentSystem()");
