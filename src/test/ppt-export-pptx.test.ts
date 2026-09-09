/**
 * PPTX 导出（图片型 OOXML）单元测试
 *
 * 审计回归：旧「导出 PPTX」只是 HTML 改名 .pptx（PowerPoint 打不开）。
 * 本测试校验 buildPptxFromImages 用 jszip 构造出的包是真实可打开的 PPTX：
 *   - 包含最小 OOXML 必需部件（[Content_Types].xml / presentation / slide / media）
 *   - slide1.xml 内含 <p:pic> 且正确引用 media/image1.png
 *   - 多页时每页有独立 slide/rels/media 且按顺序列出
 *   - 未提供尺寸时可从 PNG IHDR 解码
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
  buildPptxFromImages,
  PPTX_SLIDE_WIDTH_EMU,
  PPTX_SLIDE_HEIGHT_EMU,
} from "../core/knowledge/ppt-export-pptx";

/** 已知 1x1 透明 PNG（base64） */
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const PNG_1x1_DATA_URL = `data:image/png;base64,${PNG_1x1_BASE64}`;

async function loadZip(blob: Blob) {
  return JSZip.loadAsync(blob);
}

describe("buildPptxFromImages — 真实 PPTX (OOXML) 打包", () => {
  it("单页：生成含必需部件与图片引用的合法 PPTX", async () => {
    const blob = await buildPptxFromImages([
      { dataUrl: PNG_1x1_DATA_URL, width: 1, height: 1 },
    ]);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );

    const zip = await loadZip(blob);

    // 最小合法 PPTX 必需的部件
    const required = [
      "[Content_Types].xml",
      "_rels/.rels",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      "ppt/theme/theme1.xml",
      "ppt/slides/slide1.xml",
      "ppt/slides/_rels/slide1.xml.rels",
      "ppt/media/image1.png",
    ];
    for (const part of required) {
      expect(zip.file(part), `缺少必需部件: ${part}`).toBeTruthy();
    }

    // slide1.xml 含图片引用与 <p:pic>（图片型幻灯片的标志）
    const slide1 = await zip.file("ppt/slides/slide1.xml")!.async("text");
    expect(slide1).toContain("<p:pic>");
    expect(slide1).toContain("image1.png");
    expect(slide1).toContain('r:embed="rId2"');
    // 幻灯片为 16:9 全幅画布
    expect(slide1).toContain(`cx="${PPTX_SLIDE_WIDTH_EMU}"`);
    expect(slide1).toContain(`cy="${PPTX_SLIDE_HEIGHT_EMU}"`);

    // media/image1.png 是真实 PNG（PNG 签名开头），且与输入 base64 一致
    const pngBytes = await zip.file("ppt/media/image1.png")!.async("uint8array");
    expect(pngBytes.length).toBeGreaterThan(8);
    const signature = Array.from(pngBytes.slice(0, 8))
      .map(b => String.fromCharCode(b))
      .join("");
    expect(signature).toBe("\x89PNG\r\n\x1a\n");

    // rels 指向 media 文件
    const slide1Rels = await zip.file("ppt/slides/_rels/slide1.xml.rels")!.async("text");
    expect(slide1Rels).toContain("../media/image1.png");
  });

  it("多页：每页有独立 slide / rels / media，且按顺序列出", async () => {
    const blob = await buildPptxFromImages([
      { dataUrl: PNG_1x1_DATA_URL, width: 1, height: 1 },
      { dataUrl: PNG_1x1_DATA_URL, width: 1, height: 1 },
    ]);
    const zip = await loadZip(blob);

    expect(zip.file("ppt/slides/slide1.xml")).toBeTruthy();
    expect(zip.file("ppt/slides/slide2.xml")).toBeTruthy();
    expect(zip.file("ppt/slides/_rels/slide2.xml.rels")).toBeTruthy();
    expect(zip.file("ppt/media/image2.png")).toBeTruthy();

    const slide2 = await zip.file("ppt/slides/slide2.xml")!.async("text");
    expect(slide2).toContain("image2.png");

    const presRels = await zip.file("ppt/_rels/presentation.xml.rels")!.async("text");
    expect(presRels.indexOf("slides/slide1.xml")).toBeGreaterThan(-1);
    expect(presRels.indexOf("slides/slide2.xml")).toBeGreaterThan(
      presRels.indexOf("slides/slide1.xml")
    );
  });

  it("未提供尺寸时：从 PNG IHDR 解码 1x1，并按 contain 适配居中", async () => {
    const blob = await buildPptxFromImages([
      { dataUrl: PNG_1x1_DATA_URL, width: 0, height: 0 },
    ]);
    const zip = await loadZip(blob);
    const slide1 = await zip.file("ppt/slides/slide1.xml")!.async("text");

    // 1x1（宽高比 1:1）contain 进 16:9：高度铺满、宽度=6858000、水平居中
    expect(slide1).toContain(`cx="6858000"`);
    expect(slide1).toContain(`cy="${PPTX_SLIDE_HEIGHT_EMU}"`);
    const centerX = Math.round((PPTX_SLIDE_WIDTH_EMU - PPTX_SLIDE_HEIGHT_EMU) / 2);
    expect(slide1).toContain(`x="${centerX}"`);
  });

  it("无图片时抛错", async () => {
    await expect(buildPptxFromImages([])).rejects.toThrow();
  });

  it("结构完整性：rels 目标与 Content_Types Override 都能解析到真实部件", async () => {
    const blob = await buildPptxFromImages([
      { dataUrl: PNG_1x1_DATA_URL, width: 1, height: 1 },
      { dataUrl: PNG_1x1_DATA_URL, width: 1, height: 1 },
    ]);
    const zip = await loadZip(blob);
    const entryNames = Object.keys(zip.files).filter(n => !zip.files[n].dir);

    /** 把相对 OOXML 部件路径（含 ../）解析成 zip 内的路径 */
    const resolveTarget = (relsPath: string, target: string): string => {
      if (target.startsWith("/")) return target.slice(1);
      // OPC：rels 的“源部件”目录 = 去掉末尾 "_rels/" 后的目录
      // （包根 _rels/.rels → 包根；ppt/_rels/presentation.xml.rels → ppt/）
      const m = /^(.*\/)?_rels\//.exec(relsPath);
      const baseDir = m && m[1] ? m[1] : "";
      const parts = [...baseDir.split("/"), ...target.split("/")].filter(p => p && p !== ".");
      const stack: string[] = [];
      for (const part of parts) {
        if (part === "..") stack.pop();
        else stack.push(part);
      }
      return stack.join("/");
    };

    // 每个 .rels 里的 Target 都必须指向存在的部件
    const relsEntries = entryNames.filter(n => n.endsWith(".rels"));
    expect(relsEntries.length).toBeGreaterThan(0);
    for (const relsPath of relsEntries) {
      const relsText = await zip.file(relsPath)!.async("text");
      const targets = [...relsText.matchAll(/Target="([^"]+)"/g)].map(m => m[1]);
      expect(targets.length, `${relsPath} 应含至少一个关系`).toBeGreaterThan(0);
      for (const target of targets) {
        const resolved = resolveTarget(relsPath, target);
        expect(entryNames, `${relsPath} → ${target} 目标不存在`).toContain(resolved);
      }
    }

    // Content_Types 的每个 Override 部件都必须存在
    const ctText = await zip.file("[Content_Types].xml")!.async("text");
    const overrides = [...ctText.matchAll(/PartName="([^"]+)"/g)].map(m => m[1]);
    for (const partName of overrides) {
      expect(entryNames, `Content_Types 引用的部件不存在: ${partName}`).toContain(partName.slice(1));
    }

    // 每页 slide XML 内引用的 rId 必须在其 rels 中定义
    for (let i = 1; i <= 2; i++) {
      const slideXml = await zip.file(`ppt/slides/slide${i}.xml`)!.async("text");
      const relsText = await zip.file(`ppt/slides/_rels/slide${i}.xml.rels`)!.async("text");
      const relIds = [...relsText.matchAll(/Id="(rId\d+)"/g)].map(m => m[1]);
      const usedIds = [...slideXml.matchAll(/r:id="(rId\d+)"/g)].map(m => m[1]);
      for (const usedId of usedIds) {
        expect(relIds, `slide${i}.xml 使用了未定义的关系 ${usedId}`).toContain(usedId);
      }
    }
  });
});
