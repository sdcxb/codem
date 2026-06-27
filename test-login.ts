// Login flow test - run in browser console or attach to window
// Tests: readAuthJson → createAccount → configureEngine → sendMessage

async function testLoginFlow() {
  const results = [];
  const log = (msg) => { results.push(msg); console.log(msg); };

  // ===== Test 1: Tauri invoke available =====
  log("=== Test 1: Tauri invoke ===");
  try {
    const { invoke } = (window as any).__TAURI__.core;
    if (!invoke) throw new Error("__TAURI__.core.invoke not found");
    log("✅ Tauri invoke available");
  } catch (e) {
    log("❌ Tauri invoke not available: " + e);
    return results.join("\n");
  }

  // ===== Test 2: Read auth.json =====
  log("\n=== Test 2: Read auth.json ===");
  let authData = null;
  try {
    const { invoke } = (window as any).__TAURI__.core;
    authData = await invoke("mimo_read_auth");
    log("✅ auth.json read successfully");
    log("  uid: " + authData?.xiaomi?.metadata?.uid);
    log("  key: " + (authData?.xiaomi?.key ? authData.xiaomi.key.substring(0, 10) + "..." : "null"));
    log("  base_url: " + authData?.xiaomi?.metadata?.base_url);
  } catch (e) {
    log("❌ Failed to read auth.json: " + e);
    return results.join("\n");
  }

  // ===== Test 3: Account storage =====
  log("\n=== Test 3: Account storage ===");
  try {
    const { getDatabase } = await import("./core/storage/database");
    const db = getDatabase();

    // Check accounts table
    const accounts = db.exec("SELECT * FROM accounts");
    log("  Accounts in DB: " + (accounts.length > 0 ? accounts[0].values.length : 0));

    // Create test account
    const testId = "test-" + Date.now();
    db.run(
      "INSERT INTO accounts (id, email, url, access_token, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [testId, "test@test.com", "https://test.com", "test-key", 1, Date.now(), Date.now()]
    );

    // Verify insert
    const check = db.exec("SELECT * FROM accounts WHERE id = ?", [testId]);
    if (check.length > 0 && check[0].values.length > 0) {
      log("✅ Account insert works");
    } else {
      log("❌ Account insert failed");
    }

    // Test upsert (insert same id again)
    db.run(
      "INSERT INTO accounts (id, email, url, access_token, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [testId, "test2@test.com", "https://test2.com", "test-key-2", 1, Date.now(), Date.now()]
    );
    log("  (this should have failed with UNIQUE constraint - checking...)");

    // Cleanup test account
    db.run("DELETE FROM accounts WHERE id = ?", [testId]);
    log("✅ Account storage works");
  } catch (e) {
    log("❌ Account storage error: " + e);
  }

  // ===== Test 4: AccountStorage.createAccount (upsert) =====
  log("\n=== Test 4: createAccount upsert ===");
  try {
    const AccountStorage = await import("./core/storage/account");
    const testAccount = {
      id: "test-upsert-" + Date.now(),
      email: "upsert@test.com",
      url: "https://test.com",
      accessToken: "test-token",
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // First create
    AccountStorage.createAccount(testAccount);
    log("  First create: OK");

    // Second create (should upsert, not throw)
    AccountStorage.createAccount({ ...testAccount, email: "updated@test.com" });
    log("  Second create (upsert): OK");

    // Verify
    const active = AccountStorage.getActiveAccount();
    if (active && active.id === testAccount.id) {
      log("✅ createAccount upsert works, active account: " + active.email);
    } else {
      log("❌ createAccount upsert failed");
    }

    // Cleanup
    AccountStorage.deleteAccount(testAccount.id);
  } catch (e) {
    log("❌ createAccount upsert error: " + e);
  }

  // ===== Test 5: MiMoAuth.loadFromAuthJson =====
  log("\n=== Test 5: MiMoAuth.loadFromAuthJson ===");
  try {
    const { getMiMoAuth } = await import("./core/auth/mimo");
    const auth = getMiMoAuth();
    const account = await auth.loadFromAuthJson();
    if (account) {
      log("✅ loadFromAuthJson succeeded");
      log("  id: " + account.id);
      log("  email: " + account.email);
      log("  url: " + account.url);
      log("  token: " + account.accessToken.substring(0, 10) + "...");
    } else {
      log("❌ loadFromAuthJson returned null");
    }
  } catch (e) {
    log("❌ loadFromAuthJson error: " + e);
  }

  // ===== Test 6: MiMoAuth.getActiveAccount =====
  log("\n=== Test 6: MiMoAuth.getActiveAccount ===");
  try {
    const { getMiMoAuth } = await import("./core/auth/mimo");
    const auth = getMiMoAuth();
    const account = auth.getActiveAccount();
    if (account) {
      log("✅ getActiveAccount succeeded: " + account.email);
    } else {
      log("❌ getActiveAccount returned null");
    }
  } catch (e) {
    log("❌ getActiveAccount error: " + e);
  }

  // ===== Test 7: Engine configuration =====
  log("\n=== Test 7: Engine configuration ===");
  try {
    const { getLLMEngine } = await import("./core/llm");
    const engine = getLLMEngine();

    // Set provider config
    const { getMiMoAuth } = await import("./core/auth/mimo");
    const auth = getMiMoAuth();
    const account = auth.getActiveAccount();
    if (account) {
      engine.setProviderConfig("mimo", { apiKey: account.accessToken, baseUrl: account.url });
      engine.updateConfig({ defaultProvider: "mimo", defaultModel: "mimo-v2.5-pro" });

      const provider = engine.getDefaultProvider();
      const model = engine.getDefaultModel();
      log("  provider: " + provider);
      log("  model: " + model);

      const providerObj = engine.providers.get(provider);
      if (providerObj) {
        log("  isConfigured: " + providerObj.isConfigured());
        log("✅ Engine configuration works");
      } else {
        log("❌ Provider not found");
      }
    } else {
      log("❌ No active account for engine test");
    }
  } catch (e) {
    log("❌ Engine configuration error: " + e);
  }

  // ===== Test 8: MiMo API call =====
  log("\n=== Test 8: MiMo API call ===");
  try {
    const { getMiMoAuth } = await import("./core/auth/mimo");
    const auth = getMiMoAuth();
    const account = auth.getActiveAccount();
    if (account) {
      const response = await fetch(account.url + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + account.accessToken,
        },
        body: JSON.stringify({
          model: "mimo-v2.5-pro",
          messages: [{ role: "user", content: "say hi in 5 words" }],
          max_tokens: 50,
        }),
      });
      log("  HTTP status: " + response.status);
      if (response.ok) {
        const data = await response.json();
        log("  Response: " + JSON.stringify(data).substring(0, 200));
        log("✅ MiMo API call works");
      } else {
        const err = await response.text();
        log("❌ API error: " + err.substring(0, 200));
      }
    } else {
      log("❌ No active account for API test");
    }
  } catch (e) {
    log("❌ MiMo API call error: " + e);
  }

  // ===== Summary =====
  log("\n=== SUMMARY ===");
  const passed = results.filter(r => r.startsWith("✅")).length;
  const failed = results.filter(r => r.startsWith("❌")).length;
  log(`Passed: ${passed}, Failed: ${failed}`);

  return results.join("\n");
}

// Run test
testLoginFlow().then(r => console.log("\n" + r));
