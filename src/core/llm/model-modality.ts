/**
 * 模型选择器的**统一模态文案**（唯一口径）。
 *
 * 背景（用户实报）：同一份列表里有的模型标「视觉」、有的标「多模态」，还有的
 * 多模态模型两个都没标 —— 因为「视觉」是槽位徽标，「多模态」是能力标注，两套语义
 * 混在一起。现在：
 * - 能力标注统一由本文件产出，所有列表共用；
 * - 槽位徽标不再显示 vision（避免与能力标注重复/混淆）；
 * - `inputModalities`（供应商目录给的）优先，其次查模型能力表；无依据不猜。
 */
import { lookupModelCapabilities } from "./model-capabilities";

export function modelModalityLabel(
  modelId: string,
  inputModalities: Array<"text" | "image"> | undefined,
  lang: "zh" | "en",
): string {
  const zh = lang === "zh";
  if (inputModalities?.includes("image")) return zh ? "【多模态】" : "【Multimodal】";
  if (inputModalities?.includes("text")) return zh ? "【文本】" : "【Text】";
  const caps = lookupModelCapabilities(modelId);
  if (caps?.supportsVision) return zh ? "【多模态】" : "【Multimodal】";
  if (caps) return zh ? "【文本】" : "【Text】";
  return "";
}
