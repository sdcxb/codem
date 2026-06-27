// Test script to verify SQLite migration works
console.log("=== SQLite Migration Test ===\n");

// Check localStorage
const projectsKey = "mimo-projects";
const sessionsPrefix = "mimo-sessions-";
const chatPrefix = "mimo-chat-";

console.log("1. Checking localStorage...");
const projectsData = localStorage.getItem(projectsKey);
console.log(`   Projects key (${projectsKey}): ${projectsData ? "EXISTS" : "EMPTY"}`);
if (projectsData) {
  const projects = JSON.parse(projectsData);
  console.log(`   Projects count: ${projects.length}`);
  projects.forEach((p: any) => console.log(`   - ${p.name} (${p.id})`));
}

let sessionCount = 0;
let messageCount = 0;
for (let i = 0; i < localStorage.length; i++) {
  const key = localStorage.key(i)!;
  if (key.startsWith(sessionsPrefix)) sessionCount++;
  if (key.startsWith(chatPrefix)) messageCount++;
}
console.log(`   Sessions in localStorage: ${sessionCount}`);
console.log(`   Messages in localStorage: ${messageCount}`);

// Check SQLite
console.log("\n2. Checking SQLite...");
const dbKey = "mimo-sqlite-db";
const dbData = localStorage.getItem(dbKey);
console.log(`   Database key (${dbKey}): ${dbData ? "EXISTS (" + dbData.length + " chars)" : "EMPTY"}`);

console.log("\n=== End Test ===");
