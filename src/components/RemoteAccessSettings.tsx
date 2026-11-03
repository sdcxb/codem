/**
 * 远程访问设置卡（设置 → 连接手机）。
 *
 * 保留两条**边界明确**的通道：
 * - PC 桌面远程网关（ADR-0005，**PC 远程唯一入口**）：手机/浏览器直接看**桌面自己的**会话；
 * - Agents Anywhere（AA 账号登录，桌面引擎经回环 bridge 提供会话）。
 *
 * 桌面 Host sidecar 已退役（M4）：手机本机模式属于 Android 自己的 Host，不在这台电脑的
 * 设置里配置，也不提供第二个“连电脑”的地址/配对码入口。
 *
 * 旧的 LAN 扫码配对/二维码/批准/设备列表/自签 CA/中继已删除；不要在这里
 * 重新加回旧 LAN 配对命令或配对链接。
 */
import { useLang } from "../core/i18n/lang";
import { AaRemoteSection } from "./AaRemoteSection";
import { RemoteGatewaySection } from "./RemoteGatewaySection";

export function RemoteAccessSettings() {
  const lang = useLang();
  const zh = lang === "zh";
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: "var(--fs-md)", fontWeight: 600 }}>
        {zh ? "连接手机" : "Phone access"}
      </div>
      <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", lineHeight: 1.7 }}>
        {zh
          ? "手机连这台电脑的 Codem 通道只有桌面远程网关：它直接使用这台电脑桌面里的项目、会话和历史。手机自己的数据和会话属于手机本机模式，不在这里配置。Agents Anywhere 是可选账号通道。"
          : "The only Codem channel for reaching this PC is the desktop gateway: it uses this PC's desktop projects, sessions and history directly. Phone-local data belongs to the phone's own Host mode and is not configured here. Agents Anywhere is an optional account channel."}
      </div>

      <RemoteGatewaySection zh={zh} />
      <AaRemoteSection zh={zh} />
    </div>
  );
}
