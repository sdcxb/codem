# Vision Proxy 分析：DeepSeek 等纯文本模型的图片理解能力

> 创建时间：2026-08-02
> 参考项目：[codex-deepseek-vision](https://github.com/Anionex/codex-deepseek-vision)
> 分析目标：评估我们项目实现"视觉代理"的可行性，对比差距，给出改造方案

---

## 一、开源项目 codex-deepseek-vision 原理分析

### 1.1 核心思路

当用户贴图或 AI agent 平台内置 `view_image` 工具被调用时：

```
用户图片 → [视觉模型 API] → 详细文字描述 → [替换原图] → DeepSeek
```

DeepSeek 看到的是纯文字描述，不是图片，因此"看起来"具备了读图能力。

### 1.2 工作流程（逐层解析）

#### 步骤 1：图片检测
代理在用户请求中检测 `image_url` 类型的 content block。OpenAI 格式的多模态消息：
```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "这张图里有什么？" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
  ]
}
```

#### 步骤 2：并发视觉描述
将每张图片**并行**发给 OpenAI 兼容的多模态视觉 API（如 GPT-4o / MiMo）：
- 请求格式：标准 `chat/completions` + `image_url` content
- **解析指令**（system prompt）：要求视觉模型输出**结构化文字描述**
- 典型指令类似：`"请详细描述这张图片的内容，包括：主体、场景、文字（OCR）、颜色、布局、数据值。输出为纯文本。"`

#### 步骤 3：内容替换
将 `image_url` block 替换为 `text` block：
```
替换前: [text: "这张图里有什么？", image_url: { url: "data:..." }]
替换后: [text: "这张图里有什么？\n\n[图片描述: 这张图片显示一个销售仪表盘，包含以下数据：...]", text: ""]
```

#### 步骤 4：转发给 DeepSeek
改写后的请求（纯文本）转发给 DeepSeek，DeepSeek 正常处理。

### 1.3 关键设计决策

| 维度 | 开源项目做法 | 原因 |
|------|------------|------|
| **触发时机** | 请求拦截层（发送前） | 在 API 调用前修改，对 DeepSeek 透明 |
| **解析指令** | system prompt 指定输出格式 | 确保描述结构化、可被 LLM 利用 |
| **格式** | `image_url` → `text` block | OpenAI content array 格式兼容 |
| **并发** | 多图并行请求 | 减少延迟 |
| **缓存** | 可选缓存描述结果 | 避免重复请求同一图片 |

---

## 二、我们项目现有能力评估

### 2.1 已有的基础设施

| 能力 | 状态 | 文件 | 说明 |
|------|------|------|------|
| **类型定义** | ✅ 已有 | `types.ts:55` | `LLMMessage.content: string \| ContentBlock[]` |
| **图片 ContentBlock** | ✅ 已有 | `types.ts:64` | `{ type: "image"; mediaType: string; data: string }` |
| **模型配置方案** | ✅ 已有 | `model-profile.ts` | 7 个 TaskSlot，可按任务类型路由到不同模型 |
| **多模态设置** | ✅ 已有 | `multimodal.ts` | 3 个 provider 配置（embedding/tts/imageGen） |
| **能力检测器** | ✅ 已有 | `capability-detector.ts:22` | 已定义 `vision` 能力类型 |
| **OpenAI 兼容 Provider** | ✅ 已有 | `provider.ts` | 标准 `chat/completions` API 调用 |
| **附件格式化** | ✅ 已有 | `attachment-formatter.ts:114` | 图片附件标记为 `[Image content available via vision channel]` |

### 2.2 缺失的关键环节

| 环节 | 状态 | 问题 |
|------|------|------|
| **messagesToLLMMessages** | ❌ 只返回 string | `message.ts:573` — 只提取文本，不生成 `ContentBlock[]` |
| **toAPIMessage** | ❌ 压成纯文本 | `provider.ts:331` — `serializeContent()` 把 image block 返回空字符串 |
| **serializeContent** | ❌ 丢弃图片 | `provider.ts:357` — image type 直接 `return ""` |
| **Vision Provider 配置** | ❌ 不存在 | `MultimodalSettings` 没有 `vision` 字段 |
| **Vision Proxy 拦截层** | ❌ 不存在 | 没有在 API 调用前拦截并替换图片的逻辑 |
| **图片描述 system prompt** | ❌ 不存在 | 没有定义视觉模型的解析指令 |
| **ModelProfile vision slot** | ❌ 不存在 | `TaskSlot` 没有 `vision` 类型 |

### 2.3 结论

**我们项目目前不能实现 codex-deepseek-vision 的目标。**

虽然类型层（`ContentBlock`）支持图片，但整个链路从未连通：
1. `messagesToLLMMessages()` 不生成图片 content block
2. `toAPIMessage()` 把 `ContentBlock[]` 压成纯文本，图片被丢弃
3. 没有 vision proxy 拦截层
4. 没有 vision provider 配置入口

但基础设施已有约 60%，改造工作量中等。

---

## 三、改造方案

### 3.1 架构设计

```
用户贴图
    │
    ▼
┌─────────────────────────────────────────────┐
│ 1. messagesToLLMMessages()                   │
│    生成 ContentBlock[] (text + image)        │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│ 2. Vision Proxy Layer (新增)                 │
│    if (消息含 image block && 当前模型无 vision) │
│      → 调用 vision model 获取描述             │
│      → 替换 image block → text block         │
│    else                                      │
│      → 直接传递 (支持 vision 的模型照常处理)    │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│ 3. toAPIMessage()                           │
│    if (ContentBlock[]) → 生成 OpenAI 格式     │
│    [text block → {type:"text", text:"..."}]  │
│    [image block → {type:"image_url", ...}]   │
│    else → 纯文本 string                      │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│ 4. API 调用                                  │
│    DeepSeek 收到的是纯文本（图片已替换为描述）  │
│    GPT-4o 收到的是多模态 content（图片保留）   │
└─────────────────────────────────────────────┘
```

### 3.2 改造清单（按优先级排序）

#### P0：Vision Proxy 核心链路（必须）

| # | 文件 | 改造内容 | 难度 |
|---|------|---------|------|
| 1 | `multimodal.ts` | 新增 `VisionProviderConfig`，在 `MultimodalSettings` 中添加 `vision: MultimodalProviderConfig \| null` 字段 | 🟢 低 |
| 2 | `model-profile.ts` | 在 `TaskSlot` 中添加 `"vision"` 类型，fallback 链 `vision → chat` | 🟢 低 |
| 3 | `message.ts` | 修改 `messagesToLLMMessages()`，当 msg 含图片附件时生成 `ContentBlock[]`（text + image） | 🟡 中 |
| 4 | `provider.ts` | 修改 `toAPIMessage()`，支持 `ContentBlock[]` → OpenAI `content` array 格式（`image_url`） | 🟡 中 |
| 5 | `provider.ts` | 修改 `serializeContent()`，image block 不再返回空，而是返回 `[image: ...]` 标记 | 🟢 低 |
| 6 | **新建** `vision-proxy.ts` | Vision Proxy 拦截层：检测 image block → 调用 vision model → 替换为 text block | 🔴 高 |
| 7 | `agentic-loop.ts` | 在 `complete()` 调用前插入 Vision Proxy | 🟡 中 |

#### P1：配置 UI（用户体验）

| # | 文件 | 改造内容 | 难度 |
|---|------|---------|------|
| 8 | `SettingsPanel.tsx` | 多模态设置新增 "视觉理解" provider 配置（API Key / Base URL / Model） | 🟡 中 |
| 9 | `ModelProfilePanel.tsx` | TaskSlot 列表新增 "视觉理解" slot | 🟢 低 |
| 10 | `capability-detector.ts` | 完善 `vision` 能力检测逻辑 | 🟢 低 |

#### P2：增强功能（可选）

| # | 文件 | 改造内容 | 难度 |
|---|------|---------|------|
| 11 | `vision-proxy.ts` | 多图并行请求 | 🟡 中 |
| 12 | `vision-proxy.ts` | 描述结果缓存（SHA-256 key） | 🟡 中 |
| 13 | `vision-proxy.ts` | 可配置解析指令（system prompt 模板） | 🟢 低 |

### 3.3 核心文件改造详情

#### 3.3.1 `vision-proxy.ts`（新建）

```typescript
// 伪代码
export class VisionProxy {
  private visionConfig: MultimodalProviderConfig;
  private visionSystemPrompt: string;

  async processMessages(messages: LLMMessage[]): Promise<LLMMessage[]> {
    // 1. 检查是否有 image block
    const hasImages = messages.some(m =>
      Array.isArray(m.content) &&
      m.content.some(b => b.type === "image")
    );
    if (!hasImages) return messages; // 无图，直接通过

    // 2. 遍历消息，替换 image block
    return Promise.all(messages.map(async msg => {
      if (!Array.isArray(msg.content)) return msg;
      const newBlocks = await Promise.all(
        msg.content.map(async block => {
          if (block.type !== "image") return block;
          // 3. 调用视觉模型获取描述
          const description = await this.describeImage(block.data, block.mediaType);
          // 4. 替换为 text block
          return { type: "text", text: `[图片描述: ${description}]` };
        })
      );
      return { ...msg, content: newBlocks };
    }));
  }

  private async describeImage(base64Data: string, mediaType: string): Promise<string> {
    // 调用 OpenAI 兼容的视觉 API
    const response = await fetch(`${this.visionConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.visionConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: this.visionConfig.model,
        messages: [
          { role: "system", content: this.visionSystemPrompt },
          { role: "user", content: [
            { type: "text", text: "请详细描述这张图片。" },
            { type: "image_url", image_url: {
              url: `data:${mediaType};base64,${base64Data}`
            }}
          ]},
        ],
        max_tokens: 1000,
      }),
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "(无法识别图片内容)";
  }
}
```

**解析指令（system prompt）**：
```
你是一个视觉描述助手。请详细描述图片内容，包括：
1. 主体内容（人物、物体、场景）
2. 文字内容（OCR — 完整提取图中所有文字）
3. 数据和数值（图表、表格的具体数值）
4. 颜色和布局（设计相关）
5. 上下文和用途推断

输出格式：纯文本段落描述，不要使用 Markdown 标题。
```

#### 3.3.2 `message.ts` — `messagesToLLMMessages()` 改造

```typescript
// 当前（只返回 string）：
result.push({ id: msg.id, role: "user", content: cleanContent });

// 改造后（含图片时返回 ContentBlock[]）：
if (msg.attachments?.some(a => a.type === "image")) {
  const blocks: ContentBlock[] = [
    { type: "text", text: cleanContent },
  ];
  for (const att of msg.attachments) {
    if (att.type === "image" && att.content) {
      blocks.push({
        type: "image",
        mediaType: att.mimeType || "image/png",
        data: att.content, // base64
      });
    }
  }
  result.push({ id: msg.id, role: "user", content: blocks });
} else {
  result.push({ id: msg.id, role: "user", content: cleanContent });
}
```

#### 3.3.3 `provider.ts` — `toAPIMessage()` 改造

```typescript
// 当前（压成纯文本）：
let content = typeof msg.content === "string"
  ? msg.content
  : this.serializeContent(msg.content);

// 改造后（含 image 时生成 array）：
if (Array.isArray(msg.content)) {
  const apiContent = msg.content.map(b => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "image") return {
      type: "image_url",
      image_url: { url: `data:${b.mediaType};base64,${b.data}` }
    };
    return null;
  }).filter(Boolean);
  return { role, content: apiContent, ... };
} else {
  return { role, content: msg.content, ... };
}
```

#### 3.3.4 `agentic-loop.ts` — 插入 Vision Proxy

```typescript
// 在 complete() 调用前：
const llmMessages = MessageStorage.messagesToLLMMessages(messages);

// 新增：Vision Proxy 拦截
const visionProxy = getVisionProxy();
const processedMessages = await visionProxy.processMessages(llmMessages);

// 原有调用（processedMessages 可能已被替换图片为文字描述）
const response = await provider.complete({
  ...request,
  messages: processedMessages,
});
```

### 3.4 触发机制

| 触发条件 | 行为 |
|---------|------|
| 消息含 image block + 当前模型支持 vision | 直接传递 `image_url` 给 API（GPT-4o 原生处理） |
| 消息含 image block + 当前模型**不**支持 vision | 触发 Vision Proxy：调用视觉模型 → 替换为文字描述 |
| 消息无 image block | 不触发，正常处理 |

**判断模型是否支持 vision**：使用 `capability-detector.ts` 已有的 `vision` 能力检测。

### 3.5 配置方案

用户在 **设置 → 多模态 → 视觉理解** 中配置：
- Provider: MiMo / OpenAI / Gemini
- API Key
- Base URL
- Model: `mimo-v2.5-pro` / `gpt-4o` / `gemini-2.5-flash`

在 **设置 → 通用 → 配置方案** 中可添加 `vision` slot：
- 如果配置了 vision slot → 使用该模型做视觉描述
- 如果未配置 → fallback 到 chat slot 的模型
- 如果 chat 模型本身支持 vision → 不触发 proxy，直接传图

---

## 四、与开源项目对比

| 维度 | codex-deepseek-vision | 我们项目改造后 |
|------|----------------------|-------------|
| **触发时机** | 请求拦截层 | agentic-loop 中 complete() 调用前 |
| **图片检测** | `image_url` content block | `ContentBlock` type === "image" |
| **视觉模型** | OpenAI 兼容 API | 同（通过 MultimodalSettings 配置） |
| **解析指令** | system prompt 指定输出格式 | 同（可配置模板） |
| **替换格式** | `image_url` → `text` block | 同 |
| **并发** | 多图并行 | 同（Promise.all） |
| **缓存** | 可选 | 同（SHA-256 key，可选） |
| **配置方式** | 环境变量 | UI 界面（更友好） |
| **模型路由** | 固定 | ModelProfile 按场景路由（更灵活） |
| **vision 模型直通** | 不支持 | 支持（原生 vision 模型不经过 proxy） |

---

## 五、工作量估算

| 阶段 | 文件数 | 新增代码行 | 预计工时 |
|------|--------|----------|---------|
| P0 核心链路 | 5 改 + 1 新建 | ~300 行 | 4-6 小时 |
| P1 配置 UI | 3 改 | ~150 行 | 2-3 小时 |
| P2 增强 | 1 改 | ~100 行 | 1-2 小时 |
| **合计** | **9** | **~550 行** | **7-11 小时** |

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| base64 图片太大导致 API 拒绝 | 中 | 请求失败 | 限制图片大小 + 压缩 |
| 视觉模型描述不准确 | 中 | DeepSeek 误解 | 可配置解析指令模板 |
| 延迟增加（多一次 API 调用） | 高 | 用户体验 | 并行 + 缓存 + loading 提示 |
| vision API 费用 | 中 | 成本 | 缓存 + 可关闭 |
