# Vision Proxy 深度分析 V2：从配置入口到对话窗口的完整改造方案

> 创建时间：2026-08-02
> 基于 V1（`VISION-PROXY-ANALYSIS.md`）深化，补充配置入口缺失、模型能力矩阵、对话窗口使用流程

---

## 一、现有系统的真实状态（代码审查结论）

### 1.1 配置方案面板（ModelProfilePanel）

**实际状态**：面板**有** slot 配置表格，但存在以下缺陷：

| 维度 | 状态 | 详情 |
|------|------|------|
| 新建方案 | ⚠️ 半成品 | `CreateProfileForm` 只有名称+描述，创建后 `slots: {}` 空配置 |
| Slot 编辑 | ✅ 有 UI | 点"编辑槽位"后展开 `SlotConfigTable`，含 provider/model/reasoning 下拉 |
| 可编辑 Slot | ❌ 受限 | `EDITABLE_SLOTS = ["chat", "subagent", "memory", "compaction"]` — 只有 4 个，不含 vision/tts/imageGen/embedding |
| 内置方案 | ❌ 不可编辑 | "内置方案不可编辑槽位" — 用户看到 3 个内置方案但不能修改 |
| Provider 来源 | ❌ 硬编码 | `AVAILABLE_PROVIDERS` 硬编码 6 个 provider，不从用户实际配置的 `codem-settings.providers` 读取 |
| Slot 生效 | ✅ 已连通 | `resolveModelForTask()` 读取 `ModelProfileManager.resolveSlot()` 并匹配 provider |

**核心问题**：用户新建方案后，确实可以点"编辑槽位"配置 4 个 slot。但：
1. 内置方案不可编辑（用户想修改"经济模式"的模型不行）
2. 没有 vision slot — 无法配置"视觉理解用哪个模型"
3. Provider 列表硬编码，不读取用户实际配置的 API Key — 用户在通用设置里配了 DeepSeek API Key，但在配置方案里看到的 provider 列表是固定的
4. tts/imageGen/embedding slot 虽然在类型定义里存在，但 `EDITABLE_SLOTS` 排除了它们 — UI 上不可配置

### 1.2 多模态设置面板（MultimodalPanel）

**实际状态**：面板**有**三个模态配置（embedding/tts/imageGen），但缺失严重：

| 维度 | 状态 | 详情 |
|------|------|------|
| 模态分类 | ❌ 不足 | 只有 embedding（向量嵌入）/ tts（语音合成）/ imageGen（图像生成）三输出模态 |
| 缺少 vision | ❌ 不存在 | 没有"视觉理解/图片识别"配置入口 |
| 缺少 STT | ❌ 不存在 | 没有"语音转文字"（Speech-to-Text）配置入口 |
| 缺少图片输入 | ❌ 不存在 | "图片输入"不等于"图像生成" — 图片输入是用户贴图给模型看 |
| 模型列表 | ❌ 不完整 | `MULTIMODAL_MODELS` 中 mimo 有 imageGen 但实际 MiMo 并不能生成图片 |
| 与配置方案割裂 | ❌ 两套系统 | `MultimodalSettings` 和 `ModelProfile` 是两套独立的配置，没有打通 |

### 1.3 能力检测器（capability-detector）

**实际状态**：已有完整的能力数据库，但被忽视：

```typescript
// 已有的能力定义
type FeatureCapability =
  | 'text-generation' | 'tool-calling' | 'vision'
  | 'tts' | 'image-generation' | 'embedding' | 'streaming';

// 已有的模型能力数据库
'gpt-4o':           { supportsVision: true,  ... }
'deepseek-v3':      { supportsVision: false, ... }
'mimo-v2':          { supportsVision: false, ... }
'claude-sonnet-4':  { supportsVision: true,  ... }
'gemini-2':         { supportsVision: true,  ... }
```

**问题**：`capability-detector` 已定义了 `vision` 能力和每个模型的 `supportsVision` 标记，但 `agentic-loop.ts` 在发送请求前**从不检查**当前模型是否支持 vision，也不做任何降级处理。

### 1.4 消息处理链路

```
用户贴图 (InputArea.tsx)
    │
    ▼ image as attachment (type: "image", content: base64 dataURL)
    │
    ▼ attachment-formatter.ts:114
    │   生成文本标记: "[Image content available via vision channel]"
    │   ← ⚠️ vision channel 从未实现！图片只是被标记，没有真正传递
    │
    ▼ message.ts:573  messagesToLLMMessages()
    │   只提取 textParts，content = string — 图片信息完全丢失
    │
    ▼ provider.ts:331  toAPIMessage()
    │   serializeContent() 把 ContentBlock[] 压成纯文本
    │   image type → return "" — 图片被丢弃
    │
    ▼ fetch("/chat/completions")
    │   content: "纯文本字符串" — DeepSeek 看到的是 "[Image content available via vision channel]"
    │   ← 实际效果：DeepSeek 知道有图但看不到图，也不能描述
    │
    ▼ DeepSeek 回复
        "我看到你上传了一张图片，但我无法查看图片内容..."
```

---

## 二、模型能力矩阵（输入/输出维度）

### 2.1 多模态能力的正确分类

多模态不只是"输入"或"输出"，而是**输入能力**和**输出能力**的交叉：

| 能力 | 方向 | 说明 | 示例模型 |
|------|------|------|---------|
| **图片理解** (Vision) | 输入 | 模型能"看"图片 | GPT-4o, Claude, Gemini |
| **图片生成** (ImageGen) | 输出 | 模型能"画"图片 | DALL-E 3, Imagen |
| **语音理解** (STT) | 输入 | 模型能"听"音频 | GPT-4o-audio |
| **语音合成** (TTS) | 输出 | 模型能"说"话 | tts-1, tts-1-hd |
| **文本嵌入** (Embedding) | 输出 | 文本转向量 | text-embedding-3 |
| **视频理解** | 输入 | 模型能"看"视频 | Gemini 1.5 Pro |
| **视频生成** | 输出 | 模型能"做"视频 | Sora (未公开) |

### 2.2 当前 MULTIMODAL_MODELS 的问题

```typescript
// 当前定义
mimo: {
  embedding: ["mimo-embedding-v1"],
  tts: ["mimo-tts-v1"],           // ← MiMo 真能合成语音吗？
  imageGen: ["mimo-imagegen-v1"], // ← MiMo 真能生成图片吗？
}
deepseek: {
  embedding: [],  tts: [],  imageGen: [],  // ← 全空，但 DeepSeek 至少有 embedding？
}
```

**问题**：
1. `mimo.imageGen` 列了 `mimo-imagegen-v1` 但 MiMo 实际不支持图像生成
2. `deepseek` 全空但 DeepSeek 有 embedding API
3. **没有 vision 字段** — 无法区分"模型能看图"和"模型能画图"

### 2.3 正确的能力矩阵

```
MULTIMODAL_MODELS 应该改为：

openai: {
  vision:  ["gpt-4o", "gpt-4o-mini", "o3"],          // 输入：能看图
  imageGen: ["dall-e-3", "gpt-image-1"],              // 输出：能画图
  tts:     ["tts-1", "tts-1-hd"],                     // 输出：能说话
  stt:     ["whisper-1"],                              // 输入：能听音
  embedding: ["text-embedding-3-small", "..."],
}
mimo: {
  vision:  [],         // ← MiMo 当前不支持图片理解
  imageGen: [],        // ← MiMo 当前不支持图像生成
  tts: [],
  stt: [],
  embedding: ["mimo-embedding-v1"],
}
deepseek: {
  vision: [],          // ← DeepSeek 不支持图片理解
  imageGen: [],
  tts: [],
  stt: [],
  embedding: [],
}
gemini: {
  vision: ["gemini-2.5-flash", "gemini-2.5-pro"],     // 输入：能看图
  imageGen: ["imagen-3.0"],                            // 输出：能画图
  tts: [],
  stt: [],
  embedding: ["text-embedding-004"],
}
```

---

## 三、完整改造方案

### 3.1 改造全景图

```
┌─────────────────────────────────────────────────────────────┐
│                    用户配置层                                │
│                                                             │
│  设置 → 通用 → 模型 → 配置方案                               │
│  ┌─────────────────────────────────┐                       │
│  │ 方案: "DeepSeek + MiMo 视觉代理" │                       │
│  │  chat slot:     deepseek/v4-flash │ ← 主对话模型         │
│  │  vision slot:   mimo/v2.5-pro     │ ← 视觉描述模型       │
│  │  subagent slot: deepseek/v4-flash  │                     │
│  │  memory slot:   deepseek/v4-flash  │                     │
│  │  compaction:    deepseek/v4-flash  │                     │
│  └─────────────────────────────────┘                       │
│                                                             │
│  设置 → 多模态 → 多模态设置                                   │
│  ┌─────────────────────────────────┐                       │
│  │ 📷 图片理解 (Vision)   [启用] ✓  │ ← 新增              │
│  │    Provider: MiMo                 │                     │
│  │    Model: mimo-v2.5-pro           │                     │
│  │    API Key: (从通用设置继承)       │                     │
│  │                                  │                       │
│  │ 🎤 语音输入 (STT)      [禁用]     │ ← 新增              │
│  │ 🗣 语音合成 (TTS)      [禁用]     │ ← 已有              │
│  │ 🎨 图像生成 (ImageGen) [禁用]     │ ← 已有              │
│  │ 📐 向量嵌入 (Embedding)[本地] ✓   │ ← 已有              │
│  └─────────────────────────────────┘                       │
│                                                             │
│  设置 → 通用 → 模型 → API 配置                                │
│  ┌─────────────────────────────────┐                       │
│  │ Provider: DeepSeek               │                       │
│  │   API Key: sk-xxx                │                       │
│  │   Base URL: https://api...       │                       │
│  │   Models: [deepseek-v4-flash...] │                       │
│  │                                  │                       │
│  │ Provider: MiMo                   │                       │
│  │   API Key: (CLI 登录)             │                       │
│  │   Base URL: https://api...       │                       │
│  │   Models: [mimo-v2.5-pro...]     │                       │
│  │   ✨ Capabilities: text ✓  vision ✗  imageGen ✗         │
│  └─────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    对话窗口层                                 │
│                                                             │
│  用户粘贴图片 + 输入"这张图里有什么？"                         │
│    │                                                        │
│    ▼ InputArea.tsx                                          │
│    图片 → MessageAttachment { type: "image", content: base64 }│
│    │                                                        │
│    ▼ agentic-loop.ts                                        │
│    1. messagesToLLMMessages() 生成 ContentBlock[]             │
│       (text block + image block)                            │
│    │                                                        │
│    ▼ Vision Proxy (新增)                                     │
│    2. 检查当前模型 capability                                  │
│       resolveModelForTask("chat") → deepseek/v4-flash        │
│       capability → supportsVision = false                    │
│       → 触发 Vision Proxy!                                    │
│    │                                                        │
│    3. Vision Proxy 调用 vision 模型                           │
│       resolveModelForTask("vision") → mimo/v2.5-pro          │
│       发送: [{text:"描述这张图"}, {image_url: base64}]        │
│       接收: "这是一张销售仪表盘，包含..."                       │
│    │                                                        │
│    4. 替换 image block → text block                           │
│       content: [                                            │
│         { type: "text", text: "这张图里有什么？" },            │
│         { type: "text", text: "[图片描述: 这是一张销售仪表盘...]"} │
│       ]                                                     │
│    │                                                        │
│    ▼ provider.ts toAPIMessage()                             │
│    5. ContentBlock[] → OpenAI content array                  │
│       (此时已无 image block，全是 text)                       │
│    │                                                        │
│    ▼ DeepSeek API                                            │
│    6. DeepSeek 收到纯文本，正常回复                             │
│       "根据图片描述，这是一个销售仪表盘..."                     │
│                                                             │
│  对话窗口显示:                                                │
│    🖼️ [图片预览]                                             │
│    用户: 这张图里有什么？                                     │
│    AI: 我已通过视觉代理识别了图片内容。这是一个销售仪表盘...    │
│    [💡 视觉描述由 MiMo v2.5-pro 提供]                         │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 改造清单（深化版）

#### P0-A：多模态设置面板改造

| # | 文件 | 改造内容 | 问题修复 |
|---|------|---------|---------|
| 1 | `multimodal.ts` | `MultimodalSettings` 新增 `vision: MultimodalProviderConfig \| null` 和 `stt` 字段 | 缺少 vision/stt |
| 2 | `multimodal.ts` | `MULTIMODAL_MODELS` 改为含 `vision` 和 `stt` 字段，修正 mimo/deepseek 错误条目 | 模型能力不准确 |
| 3 | `MultimodalPanel.tsx` | `updateModality` 和 `toggleModality` 支持 `"vision"` | UI 无入口 |
| 4 | `MultimodalPanel.tsx` | `renderModalityConfig` 新增"图片理解"卡片 | UI 无入口 |
| 5 | `MultimodalPanel.tsx` | Provider 下拉从 `codem-settings.providers` 动态读取（非硬编码） | Provider 列表与用户配置脱节 |

#### P0-B：配置方案面板改造

| # | 文件 | 改造内容 | 问题修复 |
|---|------|---------|---------|
| 6 | `model-profile.ts` | `TaskSlot` 新增 `"vision"` | 无视觉 slot |
| 7 | `model-profile.ts` | `SLOT_FALLBACK` 新增 `vision: "chat"` | 缺少回退链 |
| 8 | `ModelProfilePanel.tsx` | `EDITABLE_SLOTS` 新增 `"vision"` | UI 不可编辑 |
| 9 | `ModelProfilePanel.tsx` | `SLOT_LABELS` 和 `SLOT_DESCRIPTIONS` 新增 vision | UI 无标签 |
| 10 | `ModelProfilePanel.tsx` | `AVAILABLE_PROVIDERS` 改为从 `codem-settings.providers` 动态读取 | Provider 硬编码 |
| 11 | `ModelProfilePanel.tsx` | 内置方案改为可编辑（或至少可复制后编辑） | 内置方案锁死 |

#### P0-C：Vision Proxy 核心链路

| # | 文件 | 改造内容 | 说明 |
|---|------|---------|------|
| 12 | `types.ts` | ContentBlock 已有 image 类型，无需修改 | ✅ 已就绪 |
| 13 | `message.ts` | `messagesToLLMMessages()` 当消息含图片附件时生成 `ContentBlock[]` | 当前只返回 string |
| 14 | `provider.ts` | `toAPIMessage()` 支持 `ContentBlock[]` → OpenAI content array | 当前压成纯文本 |
| 15 | **新建** `vision-proxy.ts` | 检测 image block → 查询当前模型能力 → 若不支持 vision 则调用 vision 模型获取描述 → 替换 | 核心代理层 |
| 16 | `agentic-loop.ts` | 在 `complete()` 调用前插入 Vision Proxy | 集成点 |
| 17 | `capability-detector.ts` | 修正 MiMo 的 `supportsVision`（当前标记 false 是正确的） | 验证 |

#### P1：对话窗口体验

| # | 文件 | 改造内容 | 说明 |
|---|------|---------|------|
| 18 | `InputArea.tsx` | 贴图时检测当前模型是否支持 vision，不支持时显示提示"将使用视觉代理" | 用户知情 |
| 19 | `MessageBubble.tsx` | 消息含图片时显示图片预览缩略图 | 当前只显示文件名 |
| 20 | `MessageBubble.tsx` | AI 回复时标注"💡 视觉描述由 {visionModel} 提供" | 透明度 |

### 3.3 核心文件改造详情

#### 3.3.1 `multimodal.ts` — 能力矩阵重构

```typescript
// 改造后的 MULTIMODAL_MODELS
export const MULTIMODAL_MODELS: Record<string, {
  vision: string[];    // 输入：模型能看图
  imageGen: string[];  // 输出：模型能画图
  tts: string[];       // 输出：模型能说话
  stt: string[];       // 输入：模型能听音
  embedding: string[]; // 输出：文本转向量
}> = {
  openai: {
    vision:    ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
    imageGen:  ["dall-e-3", "gpt-image-1"],
    tts:       ["tts-1", "tts-1-hd"],
    stt:       ["whisper-1"],
    embedding: ["text-embedding-3-small", "text-embedding-3-large"],
  },
  mimo: {
    vision:    [],  // MiMo 当前不支持图片理解
    imageGen:  [],  // ← 修正：删除虚假的 mimo-imagegen-v1
    tts:       [],  // ← 修正：删除虚假的 mimo-tts-v1
    stt:       [],
    embedding: ["mimo-embedding-v1"],
  },
  gemini: {
    vision:    ["gemini-2.5-flash", "gemini-2.5-pro"],
    imageGen:  ["imagen-3.0"],
    tts:       [],
    stt:       [],
    embedding: ["text-embedding-004"],
  },
  deepseek: {
    vision:    [],
    imageGen:  [],
    tts:       [],
    stt:       [],
    embedding: [],
  },
  // ...
};

// MultimodalSettings 新增 vision 字段
export interface MultimodalSettings {
  vision: MultimodalProviderConfig | null;   // 新增
  stt: MultimodalProviderConfig | null;       // 新增（预留）
  embedding: MultimodalProviderConfig | null;
  tts: MultimodalProviderConfig | null;
  imageGen: MultimodalProviderConfig | null;
}
```

#### 3.3.2 `model-profile.ts` — TaskSlot 新增 vision

```typescript
export type TaskSlot =
  | "chat" | "subagent" | "memory" | "compaction"
  | "vision"      // 新增
  | "tts" | "imageGen" | "embedding";

const SLOT_FALLBACK: Record<TaskSlot, TaskSlot | null> = {
  vision: "chat",      // 新增：vision 未配置时回退到 chat
  tts: "chat",
  imageGen: "chat",
  embedding: "chat",
  memory: "subagent",
  compaction: "subagent",
  subagent: "chat",
  chat: null,
};

// 新增内置方案
{
  id: "deepseek-vision-proxy",
  name: "DeepSeek + 视觉代理",
  description: "主对话用 DeepSeek，图片理解用 MiMo/GPT-4o 代理",
  slots: {
    chat:   { provider: "deepseek", model: "deepseek-v4-flash" },
    vision: { provider: "mimo",     model: "mimo-v2.5-pro" },
  },
}
```

#### 3.3.3 `vision-proxy.ts` — 核心代理层

```typescript
import { capabilityDetector, type FeatureCapability } from "./capability-detector";
import { resolveModelForTask } from "./model-resolver";
import { getMultimodalSettings } from "./multimodal";
import type { LLMMessage, ContentBlock } from "./types";

const VISION_SYSTEM_PROMPT = `你是一个视觉描述助手。请详细描述图片内容：
1. 主体内容（人物、物体、场景）
2. 文字内容（OCR — 完整提取图中所有文字）
3. 数据和数值（图表/表格的具体数值）
4. 颜色和布局（设计/截图的重要视觉元素）
5. 上下文和用途推断

输出格式：纯文本段落描述，不使用 Markdown 标题。`;

export class VisionProxy {
  /**
   * 处理消息列表：如果含图片且当前模型不支持 vision，则替换为文字描述
   */
  async processMessages(
    messages: LLMMessage[],
    chatModel: string,
    chatProvider: string
  ): Promise<{ messages: LLMMessage[]; visionUsed: boolean; visionModel?: string }> {
    // 1. 检查是否有 image block
    const hasImages = messages.some(m =>
      Array.isArray(m.content) &&
      m.content.some(b => b.type === "image")
    );
    if (!hasImages) return { messages, visionUsed: false };

    // 2. 检查当前主模型是否支持 vision
    const caps = capabilityDetector.checkCapability('vision', chatModel);
    if (caps.available) {
      // 模型原生支持 vision — 直接传图，不经过代理
      return { messages, visionUsed: false };
    }

    // 3. 当前模型不支持 vision — 需要代理
    // 优先从 ModelProfile 的 vision slot 获取视觉模型
    const visionResolved = await resolveModelForTask("vision");
    let visionProvider = visionResolved?.provider;
    let visionModel = visionResolved?.model;

    // 如果 ModelProfile 没配 vision slot，从 MultimodalSettings 读
    if (!visionProvider) {
      const mmSettings = getMultimodalSettings();
      if (mmSettings.vision?.enabled) {
        // 从 MultimodalSettings 构造 provider
        visionModel = mmSettings.vision.model;
        // ...构造 provider 实例
      }
    }

    if (!visionProvider || !visionModel) {
      // 没有可用的视觉模型 — 在文本中标注
      return {
        messages: this.markUnprocessedImages(messages),
        visionUsed: false,
      };
    }

    // 4. 并发处理所有 image block
    const processedMessages = await this.replaceImagesWithDescriptions(
      messages, visionProvider, visionModel
    );

    return { messages: processedMessages, visionUsed: true, visionModel };
  }

  private async replaceImagesWithDescriptions(
    messages: LLMMessage[],
    provider: any,
    model: string
  ): Promise<LLMMessage[]> {
    return Promise.all(messages.map(async msg => {
      if (!Array.isArray(msg.content)) return msg;

      const newBlocks = await Promise.all(
        msg.content.map(async (block: ContentBlock) => {
          if (block.type !== "image") return block;

          // 调用视觉模型获取描述
          const description = await this.describeImage(
            provider, model, block.data, block.mediaType
          );

          // 替换为 text block
          return {
            type: "text" as const,
            text: `[图片描述: ${description}]`,
          };
        })
      );

      return { ...msg, content: newBlocks };
    }));
  }

  private async describeImage(
    provider: any, model: string,
    base64Data: string, mediaType: string
  ): Promise<string> {
    const baseUrl = provider.config?.baseUrl || "https://api.openai.com/v1";
    const apiKey = provider.config?.apiKey || "";

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "请详细描述这张图片。" },
              { type: "image_url", image_url: {
                url: `data:${mediaType};base64,${base64Data}`
              }},
            ],
          },
        ],
        max_tokens: 1000,
        stream: false,
      }),
    });

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "(无法识别图片内容)";
  }

  private markUnprocessedImages(messages: LLMMessage[]): LLMMessage[] {
    // 没有视觉模型可用时，标注图片无法处理
    return messages.map(msg => {
      if (!Array.isArray(msg.content)) return msg;
      const newBlocks = msg.content.map((block: ContentBlock) => {
        if (block.type !== "image") return block;
        return {
          type: "text" as const,
          text: `[图片内容未处理 — 当前模型不支持视觉理解，且未配置视觉代理模型]`,
        };
      });
      return { ...msg, content: newBlocks };
    });
  }
}
```

#### 3.3.4 `agentic-loop.ts` — 集成点

```typescript
// 在 complete() 调用前插入 Vision Proxy
const llmMessages = MessageStorage.messagesToLLMMessages(messages);

// Vision Proxy 拦截
const visionProxy = new VisionProxy();
const { messages: processedMessages, visionUsed, visionModel } =
  await visionProxy.processMessages(
    llmMessages,
    resolvedModel.model,       // 当前对话模型
    resolvedModel.providerName  // 当前对话 provider
  );

// 如果触发了视觉代理，在 UI 显示提示
if (visionUsed) {
  yield { type: "status", content: `💡 视觉描述由 ${visionModel} 提供` };
}

// 调用 LLM API（processedMessages 可能已被替换图片为文字描述）
const response = await resolvedModel.provider.complete({
  ...request,
  messages: processedMessages,
});
```

### 3.4 对话窗口使用流程

#### 场景：用户用 DeepSeek 对话，贴了一张图表截图

```
用户操作:
  1. 在输入框粘贴图片 (Ctrl+V)
  2. 输入 "这张图表里哪个产品销量最高？"
  3. 点击发送

系统处理:
  ① InputArea.tsx 检测到图片附件
     → 检查当前模型 (deepseek-v4-flash) 的 vision 能力
     → capability: supportsVision = false
     → 输入框下方显示: "💡 当前模型不支持图片理解，将使用视觉代理 (mimo-v2.5-pro) 自动描述图片"

  ② 消息发送到 agentic-loop
     → messagesToLLMMessages() 生成 ContentBlock[]:
       [{ type: "text", text: "这张图表里哪个产品销量最高？" },
        { type: "image", mediaType: "image/png", data: "base64..." }]

  ③ Vision Proxy 拦截
     → 检测到 image block
     → 当前模型 deepseek-v4-flash 不支持 vision
     → 调用 mimo-v2.5-pro 获取图片描述:
       "这是一张产品销量对比柱状图。产品A销量3500件(最高)，
        产品B销量2800件，产品C销量1500件..."
     → 替换: image block → text block "[图片描述: ...]"

  ④ DeepSeek API 调用 (纯文本)
     → content: "这张图表里哪个产品销量最高？[图片描述: 这是一张产品销量对比柱状图。产品A销量3500件(最高)...]"
     → DeepSeek 回复: "根据图表数据，产品A销量最高，为3500件。"

  ⑤ 对话窗口显示
     🖼️ [图片缩略图预览]
     用户: 这张图表里哪个产品销量最高？
     AI: 根据图表数据，产品A销量最高，为3500件。
     [💡 视觉描述由 MiMo v2.5-pro 提供]
```

#### 场景：用户用 GPT-4o 对话，贴了同一张图

```
系统处理:
  ① InputArea.tsx 检测到图片
     → 当前模型 gpt-4o 的 supportsVision = true
     → 不显示代理提示，正常粘贴

  ② messagesToLLMMessages() 生成 ContentBlock[] (含 image block)

  ③ Vision Proxy 拦截
     → 检测到 image block
     → 当前模型 gpt-4o 支持 vision
     → 不触发代理，直接传图

  ④ provider toAPIMessage() 生成 OpenAI content array
     → content: [{ type: "text", text: "..." }, { type: "image_url", ... }]

  ⑤ GPT-4o API 调用 (多模态)
     → 原生图片理解，直接回复
```

---

## 四、配置入口修复方案

### 4.1 问题：Provider 列表硬编码

**当前**：`ModelProfilePanel.tsx` 的 `AVAILABLE_PROVIDERS` 是硬编码的 6 个 provider，不读取用户实际配置的 API Key。

**修复**：

```typescript
// ModelProfilePanel.tsx 改造
import { getSettingJSON } from "../core/storage/settings";

// 从用户配置中动态读取 providers
function getAvailableProviders() {
  const settings = getSettingJSON<any>("codem-settings", {});
  const configured = settings.providers || [];
  // 只显示用户配了 API Key 的 provider（mimo 除外，CLI 登录不需要 API Key）
  return configured.filter((p: any) => p.apiKey || p.id === "mimo");
}
```

### 4.2 问题：内置方案不可编辑

**当前**：`profile.isBuiltIn` 为 true 时显示"内置方案不可编辑槽位"。

**修复方案**：改为"复制后编辑"模式 — 内置方案不可直接修改，但可以"另存为副本"后编辑：

```typescript
const handleDuplicate = (profile: ModelProfile) => {
  const newProfile = manager.createProfile({
    name: `${profile.name} (副本)`,
    description: profile.description,
    enabled: true,
    slots: { ...profile.slots },
  });
  manager.setActiveProfile(newProfile.id);
  setEditingProfileId(newProfile.id);
  refresh();
};
```

### 4.3 问题：EDITABLE_SLOTS 排除了多模态 slot

**当前**：`EDITABLE_SLOTS = ["chat", "subagent", "memory", "compaction"]`

**修复**：

```typescript
const EDITABLE_SLOTS: TaskSlot[] = [
  "chat", "subagent", "memory", "compaction",
  "vision",     // 新增
  "tts",        // 解锁
  "imageGen",   // 解锁
  "embedding",  // 解锁
];
```

---

## 五、工作量估算（修正版）

| 阶段 | 文件数 | 新增/修改代码行 | 预计工时 |
|------|--------|-------------|---------|
| P0-A 多模态面板 | 3 改 | ~200 行 | 3 小时 |
| P0-B 配置方案面板 | 3 改 | ~150 行 | 2 小时 |
| P0-C Vision Proxy 链路 | 4 改 + 1 新建 | ~350 行 | 5 小时 |
| P1 对话窗口 | 3 改 | ~100 行 | 2 小时 |
| P2 内置方案+Provider动态化 | 1 改 | ~50 行 | 1 小时 |
| **合计** | **15** | **~850 行** | **13 小时** |

### 依赖关系

```
P0-A (多模态设置) ─┐
P0-B (配置方案)   ─┤── P0-C (Vision Proxy) ── P1 (对话窗口)
                   │                              ── P2 (内置方案)
                   │
multimodal.ts ─────┘
model-profile.ts ──┘
```

P0-A 和 P0-B 可并行，P0-C 依赖两者，P1/P2 依赖 P0-C。
