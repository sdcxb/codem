/**
 * 变异波次：自定义 Provider 的「添加」必须并入规范保存流程。
 *
 * 两条变异分别对应两种"退回旧行为"：只调不带参数的 handleSave（新 provider 进不了库），
 * 以及没确认就收起表单（把"没存上"演成"已添加"）。
 */
export default {
  description:
    "addCustomProvider 走 handleSave(新列表) 并在确认后才收起表单；变异：不传新列表 / 未确认也收起 ⇒ CUSTPROV-3 必须红",
  mutations: [
    {
      id: "MUT-1 只调 handleSave()（不传刚算出的列表）",
      why: "CUSTPROV-3：setSettings 是异步的，handleSave 读到旧 settings ⇒ 新 provider 不会进库（旧缺陷形态）",
      patches: [
        {
          file: "src/components/SettingsPanel.tsx",
          from: "    const confirmed = await handleSave(newSettings);",
          to: "    const confirmed = await handleSave();",
        },
      ],
      tests: ["src/test/custom-provider-save-flow.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 未确认也收起表单",
      why: "CUSTPROV-3：把「没存上」演成「已添加」，用户不会重试",
      patches: [
        {
          file: "src/components/SettingsPanel.tsx",
          from: "    if (!confirmed) return;\n    setShowAddCustom(false);",
          to: "    if (false) return;\n    setShowAddCustom(false);",
        },
      ],
      tests: ["src/test/custom-provider-save-flow.test.ts"],
      expectRed: true,
    },
  ],
};
