import { describe, it, expect, vi } from "vitest";

// Mock settings with a shared store
const mockStore = new Map<string, string>();

vi.mock("../core/storage/settings", () => ({
  getSetting: vi.fn((key: string) => mockStore.get(key) || ""),
  setSetting: vi.fn((key: string, val: string) => { mockStore.set(key, val); }),
  getSettingJSON: vi.fn(<T>(key: string, def: T) => {
    const val = mockStore.get(key);
    if (!val) return def;
    try { return JSON.parse(val) as T; } catch { return def; }
  }),
  setSettingJSON: vi.fn((key: string, val: unknown) => {
    mockStore.set(key, JSON.stringify(val));
  }),
}));

// Mock database
vi.mock("../core/storage/database", () => ({
  getDatabase: vi.fn(() => ({
    run: vi.fn(),
    exec: vi.fn(() => []),
  })),
  persistDatabase: vi.fn(),
}));

// Mock event-log
vi.mock("../core/storage/event-log", () => ({
  getEventLog: vi.fn(() => ({
    readAll: vi.fn(() => []),
    readFrom: vi.fn(() => []),
    append: vi.fn(),
    appendBatch: vi.fn(),
    count: vi.fn(() => 0),
    getLatestSeq: vi.fn(() => 0),
  })),
}));

import {
  getSyncConfig,
  setSyncConfig,
  getDeviceId,
  isSyncReady,
  DEFAULT_SYNC_CONFIG,
  type SyncConfig,
} from "../core/storage/sync-engine";

describe("P3-23: Remote Persistence Sync", () => {

  describe("Config Management", () => {
    it("should return default config when none saved", () => {
      mockStore.clear();
      const config = getSyncConfig();
      expect(config.backend).toBe("none");
      expect(config.autoSync).toBe(false);
      expect(config.direction).toBe("both");
      expect(config.autoSyncInterval).toBe(30_000);
    });

    it("should persist config changes", () => {
      mockStore.clear();
      const config: SyncConfig = {
        backend: "supabase",
        supabaseUrl: "https://example.supabase.co",
        supabaseKey: "test-key",
        autoSync: true,
        autoSyncInterval: 60_000,
        direction: "push",
        sessionIds: ["session-1"],
      };
      setSyncConfig(config);

      const loaded = getSyncConfig();
      expect(loaded.backend).toBe("supabase");
      expect(loaded.supabaseUrl).toBe("https://example.supabase.co");
      expect(loaded.autoSync).toBe(true);
      expect(loaded.direction).toBe("push");
      expect(loaded.sessionIds).toEqual(["session-1"]);
    });

    it("should merge with defaults for missing fields", () => {
      mockStore.clear();
      setSyncConfig({ backend: "rest-api", apiUrl: "https://api.example.com" } as SyncConfig);
      const config = getSyncConfig();
      expect(config.autoSync).toBe(false); // from default
      expect(config.direction).toBe("both"); // from default
    });
  });

  describe("Device ID", () => {
    it("should generate a device ID on first access", () => {
      mockStore.clear();
      const id = getDeviceId();
      expect(id).toBeTruthy();
      expect(id.startsWith("dev_")).toBe(true);
    });

    it("should return same device ID on subsequent calls", () => {
      mockStore.clear();
      const id1 = getDeviceId();
      const id2 = getDeviceId();
      expect(id1).toBe(id2);
    });
  });

  describe("Sync Readiness", () => {
    it("should not be ready when backend is none", () => {
      mockStore.clear();
      expect(isSyncReady()).toBe(false);
    });

    it("should not be ready when supabase missing URL", () => {
      mockStore.clear();
      setSyncConfig({
        backend: "supabase",
        supabaseKey: "key",
        autoSync: false,
        autoSyncInterval: 30_000,
        direction: "both",
        sessionIds: [],
      } as SyncConfig);
      expect(isSyncReady()).toBe(false);
    });

    it("should not be ready when supabase missing key", () => {
      mockStore.clear();
      setSyncConfig({
        backend: "supabase",
        supabaseUrl: "https://example.supabase.co",
        autoSync: false,
        autoSyncInterval: 30_000,
        direction: "both",
        sessionIds: [],
      } as SyncConfig);
      expect(isSyncReady()).toBe(false);
    });

    it("should be ready when supabase fully configured", () => {
      mockStore.clear();
      setSyncConfig({
        backend: "supabase",
        supabaseUrl: "https://example.supabase.co",
        supabaseKey: "test-key",
        autoSync: false,
        autoSyncInterval: 30_000,
        direction: "both",
        sessionIds: [],
      } as SyncConfig);
      expect(isSyncReady()).toBe(true);
    });

    it("should be ready when REST API configured", () => {
      mockStore.clear();
      setSyncConfig({
        backend: "rest-api",
        apiUrl: "https://api.example.com",
        autoSync: false,
        autoSyncInterval: 30_000,
        direction: "both",
        sessionIds: [],
      } as SyncConfig);
      expect(isSyncReady()).toBe(true);
    });
  });

  describe("Default Config", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_SYNC_CONFIG.backend).toBe("none");
      expect(DEFAULT_SYNC_CONFIG.autoSync).toBe(false);
      expect(DEFAULT_SYNC_CONFIG.autoSyncInterval).toBeGreaterThanOrEqual(10_000);
      expect(DEFAULT_SYNC_CONFIG.direction).toBe("both");
      expect(DEFAULT_SYNC_CONFIG.sessionIds).toEqual([]);
    });
  });
});
