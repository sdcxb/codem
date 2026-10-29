# stacks/ —— 本地「技能包」描述（P2-7 的本地一半）

> 这不是市场，也不是安装器。它只回答一个问题：**一个包引用了哪些技能、版本是多少、
> 有没有工作流文件**，并让 `npm run audit:stacks` 在结构上拒绝"装了但跑不起来"的包。

## 格式

```
stacks/<包名>/codem-stack.json
stacks/<包名>/WORKFLOW.md        # 可选，manifest 里 workflow 指向它
```

```json
{
  "name": "review-pack",
  "version": "1.0.0",
  "description": "代码评审用的一组技能",
  "skills": ["independent-review", "retro"],
  "workflow": "WORKFLOW.md"
}
```

规则（`tools/audit/check-stack-manifests.mjs`）：

- `name`：小写字母/数字/连字符，且与目录名一致（校验器以目录名为准）；
- `version`：semver（`1.2.3` / `1.2.3-beta.1`）；
- `skills`：非空、不重复、**每个技能必须在 `src/core/skills/<name>/SKILL.md` 存在**；
- `workflow`：可选；必须是包内相对路径（禁止绝对路径与 `..`），声明了就必须存在。

## 明确不做

- 远程市场、下载/安装、依赖解析；
- 版本递增门禁（"改了文件必须升版本"只有在有远程分发时才有意义）；
- 与 DSH 插件市场的映射。

这些都需要先决定「谁拥有版本号、更新怎么传播、卸载粒度」——是产品取舍，不是校验器能替答的问题。
