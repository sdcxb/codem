# 插件更新真机验证（dsh-ops）

日期：2026-10-23
提交：`ff6c049b`

## 1. 功能

「插件管理 → 已安装」新增 **DSH Ops / DSH 已安装插件** 卡片：

- 读 DSH profile 的 `dependencies` 与 `node_modules/<name>/package.json`；
- `检查更新` → `npm view <name> version`；
- `升级并安装` → `npm install <name>@<latest>`，成功后**回读**版本；
- `停用/启用` 写入 `codem-external-dsh-disabled`，不注入插件代码到 Codem 运行时。

## 2. dsh-ops 真机升级

为制造可更新状态，先把 `~/.dsh/profiles/desktop` 里的 dsh-ops 降到 `0.4.0`：

```text
npm install dsh-ops@0.4.0
0.4.0
```

打开插件管理，卡片显示：

```text
dsh-ops v0.4.0 → v0.4.1   升级并安装
```

点击升级后：

```text
dsh-ops v0.4.1   已启用
node -p require('dsh-ops/package.json').version
0.4.1
```

## 3. 停用与独立性

点 dsh-ops 右侧开关：

```text
dsh-ops v0.4.1 已停用
```

刷新页面后仍为「已停用」，设置值为 `["dsh-ops"]`。

停用状态下新建会话并执行：

```text
bash: node -v
输出：v24.19.0
```

Codem 的插件管理、会话、bash 工具均正常；dsh-ops 的代码没有进入 Codem 运行时，因此它的停用不会影响 Codem 其他功能，也不会反向卸载 DSH 的安装。

## 4. 可靠性判据

`src/test/external-dsh-plugins.test.ts`：

- EXT-1：home/profile 路径与 semver 比较；
- EXT-2：只读 dependencies，不把传递依赖/官方包当插件；
- EXT-3：检查到新版本才标记 updateAvailable；
- EXT-4：升级后必须回读版本，版本没变不算成功；
- EXT-5：`npm view` 失败必须报 error，不伪装成已是最新；
- EXT-6：`npm install` 非 0 退出必须 `ok=false`，版本不变。

## 5. 全量审计

```text
npx tsc --noEmit                                      exit 0
npx vitest run --maxWorkers=2                         733 files / 8499 passed + 17 skipped
node tools/audit/scan-report-sites.mjs --check        270/270 triaged, 0 pending
```

截图：[plugin-mode/images/08-plugin-updates.png](../manuals/project-mode/images/08-plugin-updates.png)
