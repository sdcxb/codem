// Diagnostic: Check if messages are saved in the database
// Run this in the browser console (F12) to verify message persistence

async function checkMessages() {
  const { invoke } = window.__TAURI__.core;
  
  // Read the SQLite database
  try {
    const dbBase64 = localStorage.getItem("mimo-sqlite-db");
    if (!dbBase64) {
      console.log("❌ No database found in localStorage");
      return;
    }
    
    console.log("✅ Database found, size:", dbBase64.length, "bytes");
    
    // Use the storage module to list messages
    const { getDatabase } = await import("./src/core/storage/database");
    const db = getDatabase();
    
    // Count messages
    const countResult = db.exec("SELECT COUNT(*) FROM messages");
    const totalMessages = countResult[0]?.values[0]?.[0] || 0;
    console.log("📊 Total messages in DB:", totalMessages);
    
    // Count by role
    const roleResult = db.exec("SELECT role, COUNT(*) FROM messages GROUP BY role");
    console.log("📊 Messages by role:");
    for (const row of roleResult[0]?.values || []) {
      console.log(`  ${row[0]}: ${row[1]}`);
    }
    
    // List recent messages
    const recentResult = db.exec("SELECT id, role, substr(content, 1, 50), timestamp FROM messages ORDER BY timestamp DESC LIMIT 10");
    console.log("📋 Recent messages:");
    for (const row of recentResult[0]?.values || []) {
      console.log(`  [${row[1]}] ${row[2]} (${new Date(row[3]).toLocaleString()})`);
    }
    
    // Check sessions
    const sessionResult = db.exec("SELECT id, title, message_count FROM sessions ORDER BY last_message_at DESC LIMIT 5");
    console.log("📋 Recent sessions:");
    for (const row of sessionResult[0]?.values || []) {
      console.log(`  ${row[1]} (${row[2]} messages)`);
    }
    
  } catch (e) {
    console.error("❌ Error checking database:", e);
  }
}

checkMessages();
