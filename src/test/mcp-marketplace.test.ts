import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock settings before importing
vi.mock("../core/storage/settings", () => ({
  getSetting: vi.fn(() => ""),
  setSetting: vi.fn(),
  getSettingJSON: vi.fn(() => []),
  setSettingJSON: vi.fn(),
}));

// Mock Tauri
(window as any).__TAURI__ = {
  core: {
    invoke: vi.fn(),
  },
};

import {
  getCatalog,
  getByCategory,
  searchCatalog,
  getCategories,
  isEntryInstalled,
  installCatalogEntry,
  uninstallCatalogEntry,
  CATEGORY_LABELS,
  type MCPRegistryEntry,
} from "../core/mcp/mcp-registry-catalog";
import { getMCPRegistry } from "../core/mcp/mcp";

describe("P3-22: MCP Marketplace Catalog", () => {
  describe("Catalog Data", () => {
    it("should have non-empty catalog", () => {
      const catalog = getCatalog();
      expect(catalog.length).toBeGreaterThan(5);
    });

    it("should have unique IDs", () => {
      const catalog = getCatalog();
      const ids = catalog.map((e) => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("should have required fields for each entry", () => {
      const catalog = getCatalog();
      for (const entry of catalog) {
        expect(entry.id).toBeTruthy();
        expect(entry.name).toBeTruthy();
        expect(entry.description).toBeTruthy();
        expect(entry.author).toBeTruthy();
        expect(entry.category).toBeTruthy();
        expect(entry.transport).toBeTruthy();
      }
    });

    it("should have valid transport type for each entry", () => {
      const catalog = getCatalog();
      for (const entry of catalog) {
        expect(["stdio", "http", "sse"]).toContain(entry.transport);
      }
    });

    it("should have command for stdio entries", () => {
      const stdioEntries = getCatalog().filter((e) => e.transport === "stdio");
      for (const entry of stdioEntries) {
        expect(entry.command).toBeTruthy();
      }
    });

    it("should have url for http/sse entries", () => {
      const httpEntries = getCatalog().filter(
        (e) => e.transport === "http" || e.transport === "sse"
      );
      for (const entry of httpEntries) {
        expect(entry.url).toBeTruthy();
      }
    });
  });

  describe("Category Operations", () => {
    it("should return categories list", () => {
      const cats = getCategories();
      expect(cats.length).toBeGreaterThan(0);
    });

    it("should filter by category", () => {
      const dbEntries = getByCategory("database");
      expect(dbEntries.length).toBeGreaterThan(0);
      for (const entry of dbEntries) {
        expect(entry.category).toBe("database");
      }
    });

    it("should have labels for all categories", () => {
      const cats = getCategories();
      for (const cat of cats) {
        expect(CATEGORY_LABELS[cat]).toBeTruthy();
        expect(CATEGORY_LABELS[cat].zh).toBeTruthy();
        expect(CATEGORY_LABELS[cat].en).toBeTruthy();
      }
    });
  });

  describe("Search", () => {
    it("should return all entries on empty query", () => {
      const results = searchCatalog("");
      expect(results.length).toBe(getCatalog().length);
    });

    it("should find by name", () => {
      const results = searchCatalog("filesystem");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((e) => e.name.toLowerCase().includes("filesystem"))).toBe(true);
    });

    it("should find by tag", () => {
      const results = searchCatalog("git");
      expect(results.length).toBeGreaterThan(0);
    });

    it("should be case-insensitive", () => {
      const lower = searchCatalog("github");
      const upper = searchCatalog("GITHUB");
      expect(lower.length).toBe(upper.length);
    });

    it("should return empty for non-existent query", () => {
      const results = searchCatalog("xyz_nonexistent_12345");
      expect(results.length).toBe(0);
    });
  });

  describe("Install / Uninstall", () => {
    beforeEach(() => {
      // Clear existing configs
      const registry = getMCPRegistry();
      for (const config of registry.getConfigs()) {
        registry.removeServer(config.name);
      }
    });

    it("should install a catalog entry", () => {
      const entry = getCatalog().find((e) => e.id === "filesystem")!;
      const result = installCatalogEntry(entry);
      expect(result.success).toBe(true);

      const installed = isEntryInstalled(entry);
      expect(installed).toBe(true);
    });

    it("should fail to install duplicate", () => {
      const entry = getCatalog().find((e) => e.id === "memory")!;
      installCatalogEntry(entry);
      const result = installCatalogEntry(entry);
      expect(result.success).toBe(false);
      expect(result.error).toContain("已存在");
    });

    it("should uninstall a catalog entry", () => {
      const entry = getCatalog().find((e) => e.id === "fetch")!;
      installCatalogEntry(entry);
      expect(isEntryInstalled(entry)).toBe(true);

      const result = uninstallCatalogEntry(entry);
      expect(result.success).toBe(true);
      expect(isEntryInstalled(entry)).toBe(false);
    });

    it("should fail to uninstall non-installed entry", () => {
      const entry = getCatalog().find((e) => e.id === "puppeteer")!;
      const result = uninstallCatalogEntry(entry);
      expect(result.success).toBe(false);
    });

    it("should install with env overrides", () => {
      const entry = getCatalog().find((e) => e.id === "github")!;
      const env = { GITHUB_PERSONAL_ACCESS_TOKEN: "test-token" };
      const result = installCatalogEntry(entry, env);
      expect(result.success).toBe(true);

      const registry = getMCPRegistry();
      const config = registry.getConfigs().find((c) => c.name === "github");
      expect(config?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("test-token");
    });
  });
});
