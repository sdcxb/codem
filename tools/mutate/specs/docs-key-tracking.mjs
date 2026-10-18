/** 变异波次：关键文档强制入库（.gitignore negation + 判据）。 */
export default {
  description:
    "关键文档靠 .gitignore 的 negation 显式放行，并由 DOCSKEY-1..3 验证存在/被跟踪/不被忽略；变异：去掉 ui-spec 的放行 ⇒ DOCSKEY-3 必须红",
  mutations: [
    {
      id: "MUT-1 去掉 ui-spec 的放行规则",
      why: "DOCSKEY-3：negation 缺失时该文档重新变成 ignored（新克隆/新会话拿不到它）",
      patches: [
        {
          file: ".gitignore",
          from: "!docs/ui-spec.md",
          to: "# !docs/ui-spec.md (mutated)",
        },
      ],
      tests: ["src/test/docs-key-tracking.test.ts"],
      expectRed: true,
    },
  ],
};
