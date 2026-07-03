const initSqlJs = require('sql.js/dist/sql-asm.js');
const fs = require('fs');

async function main() {
  const SQL = await initSqlJs();
  
  // Check Codem database (localStorage based)
  // We can't access localStorage from Node, but we can check the v2_sessions table
  
  // Check MiMoCode database
  const dbPath = 'C:/Users/123/.local/share/mimocode/mimocode.db';
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);
  
  // Count sessions with Claude Code references
  console.log('=== Sessions with Claude Code references ===');
  try {
    const sessions = db.exec("SELECT id, title FROM session WHERE title LIKE '%Claude%' OR title LIKE '%claude%' LIMIT 10");
    if (sessions.length > 0) {
      sessions[0].values.forEach(row => console.log(`ID: ${row[0]}, Title: ${row[1]}`));
    } else {
      console.log('No sessions with Claude in title');
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
  
  // Count messages with Claude Code references
  console.log('\n=== Messages with Claude Code references ===');
  try {
    const messages = db.exec("SELECT COUNT(*) FROM message WHERE data LIKE '%Claude Code%'");
    if (messages.length > 0) {
      console.log('Count:', messages[0].values[0][0]);
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
  
  // Check v2_sessions table in Codem database
  console.log('\n=== v2_sessions table structure ===');
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='v2_sessions'");
    if (tables.length > 0 && tables[0].values.length > 0) {
      console.log('v2_sessions table exists');
      const count = db.exec("SELECT COUNT(*) FROM v2_sessions");
      console.log('Count:', count[0].values[0][0]);
    } else {
      console.log('v2_sessions table does not exist in MiMoCode database');
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
  
  db.close();
}
main().catch(console.error);
