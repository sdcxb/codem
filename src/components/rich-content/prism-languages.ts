/**
 * Prism 语言注册表（**只注册产品实际会遇到的**）。
 *
 * ## 为什么要这个文件（第 233 轮审计 · P2 冷启动）
 *
 * `react-syntax-highlighter` 的 `Prism`（非 Light）版本在**模块加载时**就 `require`
 * Prism 的**全语言包**（200+ 语言，压缩前 ~1 MB）。原来 `CodeBlockView` 直接引它
 * ⇒ 这一大块静态进主 chunk ⇒ 首帧必须下载/解析（真机主包 5.5 MB 里最大的一块）。
 *
 * `PrismLight` 的语义正好相反：**注册几种就带几种**。这里列出的就是"贴代码时
 * 真机上会遇到的语言"；没注册的降级成纯文本（`COLD-4` 钉着"不抛、能显示"）。
 *
 * ⚠️ 加语言时：在下面 `registerLanguage` 里加一行即可，别改回全量 `Prism`。
 */
import { PrismLight } from "react-syntax-highlighter";
import ts from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import js from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import scss from "react-syntax-highlighter/dist/esm/languages/prism/scss";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import powershell from "react-syntax-highlighter/dist/esm/languages/prism/powershell";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";

/** 已注册的语言名（判据 COLD-2 读它；顺序不影响行为） */
export const PRISM_REGISTERED_LANGUAGES: readonly string[] = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "css",
  "scss",
  "markup",
  "bash",
  "powershell",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "sql",
  "yaml",
  "markdown",
  "toml",
  "diff",
  "ini",
  "docker",
  "kotlin",
  "swift",
  "ruby",
  "php",
];

const LANGS: Record<string, unknown> = {
  typescript: ts,
  tsx,
  javascript: js,
  jsx,
  json,
  css,
  scss,
  markup,
  bash,
  powershell,
  python,
  rust,
  go,
  java,
  c,
  cpp,
  sql,
  yaml,
  markdown,
  toml,
  diff,
  ini,
  docker,
  kotlin,
  swift,
  ruby,
  php,
};

/** 语言别名（代码块上的 `lang` 常常是简写/别名） */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  typescriptreact: "tsx",
  js: "javascript",
  javascriptreact: "jsx",
  jsx: "jsx",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  ps1: "powershell",
  pwsh: "powershell",
  py: "python",
  rs: "rust",
  golang: "go",
  html: "markup",
  xml: "markup",
  svg: "markup",
  md: "markdown",
  yml: "yaml",
  "c++": "cpp",
  cs: "csharp",
  "objective-c": "objectivec",
};

let registered = false;

/** 幂等注册（模块级只做一次） */
export function ensurePrismLanguagesRegistered(): void {
  if (registered) return;
  for (const name of PRISM_REGISTERED_LANGUAGES) {
    PrismLight.registerLanguage(name, LANGS[name] as never);
  }
  registered = true;
}

/**
 * 把代码块上的 `lang` 归一到已注册的名字；未注册 ⇒ 返回 `undefined`
 * （调用方据此渲染纯文本）。
 */
export function resolvePrismLanguage(language: string | undefined | null): string | undefined {
  const raw = (language ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  const candidate = ALIASES[raw] ?? raw;
  return PRISM_REGISTERED_LANGUAGES.includes(candidate) ? candidate : undefined;
}
