import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../design/components/common.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../../state/app_state.dart';
import '../hosts/host_sheets.dart';

class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key, required this.state});

  final CodemAppState state;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return SafeArea(
      bottom: false,
      child: ListenableBuilder(
        listenable: state,
        builder: (context, _) => ListView(
          padding: const EdgeInsets.fromLTRB(CodemSpace.xl, CodemSpace.md, CodemSpace.xl, 32),
          children: [
            Row(
              children: [
                Text('设置', style: context.texts.headlineSmall?.copyWith(fontSize: 24)),
                const Spacer(),
                HostPill(
                  name: state.activeHost?.name ?? '未连接',
                  online: state.connected,
                  onTap: () => showHostsSheet(context, state),
                ),
              ],
            ),
            const SizedBox(height: CodemSpace.xl),
            _SectionTitle('外观'),
            SectionCard(
              child: Column(
                children: [
                  Row(
                    children: [
                      Icon(LucideIcons.sunMoon, size: 18, color: palette.textSecondary),
                      const SizedBox(width: CodemSpace.md),
                      Expanded(child: Text('主题', style: context.texts.bodyLarge)),
                      _ThemeChoice(
                        current: state.themeMode,
                        onChanged: state.setTheme,
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: CodemSpace.xl),
            _SectionTitle('远程'),
            SectionCard(
              child: Column(
                children: [
                  _SettingRow(
                    icon: LucideIcons.monitorSmartphone,
                    title: '主机',
                    value: state.activeHost == null
                        ? '未连接'
                        : '${state.activeHost!.name} · ${state.connected ? '在线' : '离线'}',
                    onTap: () => showHostsSheet(context, state),
                  ),
                  Divider(color: palette.hairline, height: 1),
                  _SettingRow(
                    icon: LucideIcons.plus,
                    title: '添加电脑',
                    value: 'Tailscale 地址 / 配对码',
                    onTap: () => showAddHostSheet(context, state),
                  ),
                  Divider(color: palette.hairline, height: 1),
                  _SettingRow(
                    icon: LucideIcons.wifi,
                    title: '连接',
                    value: state.connected ? '已连接' : (state.connecting ? '连接中…' : '未连接'),
                    onTap: state.retry,
                  ),
                  Divider(color: palette.hairline, height: 1),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    secondary: Icon(LucideIcons.batteryCharging, size: 18, color: palette.textSecondary),
                    title: Text('后台保持连接', style: context.texts.bodyLarge?.copyWith(fontSize: 15)),
                    subtitle: Text('通过前台服务减少被系统回收', style: context.texts.bodySmall),
                    value: state.keepAwake,
                    onChanged: state.setKeepAwake,
                    activeThumbColor: palette.accent,
                  ),
                ],
              ),
            ),
            const SizedBox(height: CodemSpace.xl),
            _SectionTitle('数据与隐私'),
            SectionCard(
              child: Column(
                children: [
                  _InfoRow(
                    icon: LucideIcons.shield,
                    title: '本地优先',
                    body: '会话、项目、文件都在你的 PC 上；手机只是远程窗口。',
                  ),
                  Divider(color: palette.hairline, height: 1),
                  _InfoRow(
                    icon: LucideIcons.lock,
                    title: '传输',
                    body: '通过 Tailscale 的加密连接直达你的电脑；不经过 Codem 的服务器。',
                  ),
                ],
              ),
            ),
            const SizedBox(height: CodemSpace.xl),
            _SectionTitle('关于'),
            SectionCard(
              child: Column(
                children: [
                  _SettingRow(
                    icon: LucideIcons.info,
                    title: 'Codem Mobile',
                    value: '0.1.0 · Flutter N0',
                    onTap: null,
                  ),
                  Divider(color: palette.hairline, height: 1),
                  _SettingRow(
                    icon: LucideIcons.code,
                    title: '开源',
                    value: 'github.com/sdcxb/codem',
                    onTap: null,
                  ),
                ],
              ),
            ),
            const SizedBox(height: CodemSpace.xl),
            Center(
              child: Text(
                'N0 设计基线 · 数据不出设备',
                style: context.texts.labelSmall?.copyWith(fontSize: 11),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: CodemSpace.xs, bottom: CodemSpace.sm),
      child: Text(
        text,
        style: context.texts.labelMedium?.copyWith(fontSize: 12, letterSpacing: 0.4),
      ),
    );
  }
}

class _ThemeChoice extends StatelessWidget {
  const _ThemeChoice({required this.current, required this.onChanged});

  final ThemeMode current;
  final ValueChanged<ThemeMode> onChanged;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final items = const [
      (ThemeMode.dark, LucideIcons.moon, '深色'),
      (ThemeMode.light, LucideIcons.sun, '浅色'),
      (ThemeMode.system, LucideIcons.monitor, '系统'),
    ];
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final item in items)
          Padding(
            padding: const EdgeInsets.only(left: CodemSpace.xs),
            child: InkWell(
              onTap: () => onChanged(item.$1),
              borderRadius: BorderRadius.circular(CodemRadius.sm),
              child: Container(
                width: 40,
                height: 36,
                decoration: BoxDecoration(
                  color: current == item.$1 ? palette.accent.withValues(alpha: 0.14) : Colors.transparent,
                  borderRadius: BorderRadius.circular(CodemRadius.sm),
                  border: Border.all(
                    color: current == item.$1 ? palette.accent.withValues(alpha: 0.4) : palette.hairline,
                  ),
                ),
                child: Icon(
                  item.$2,
                  size: 16,
                  color: current == item.$1 ? palette.accent : palette.textSecondary,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _SettingRow extends StatelessWidget {
  const _SettingRow({
    required this.icon,
    required this.title,
    required this.value,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String value;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final row = SizedBox(
      height: 56,
      child: Row(
        children: [
          Icon(icon, size: 18, color: palette.textSecondary),
          const SizedBox(width: CodemSpace.md),
          Text(title, style: context.texts.bodyLarge?.copyWith(fontSize: 15)),
          const Spacer(),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 170),
            child: Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.right,
              style: context.texts.bodySmall?.copyWith(color: palette.textSecondary),
            ),
          ),
          if (onTap != null) ...[
            const SizedBox(width: CodemSpace.xs),
            Icon(LucideIcons.chevronRight, size: 16, color: palette.textSecondary),
          ],
        ],
      ),
    );
    if (onTap == null) return row;
    return InkWell(onTap: onTap, child: row);
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.icon, required this.title, required this.body});

  final IconData icon;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: CodemSpace.md),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: palette.textSecondary),
          const SizedBox(width: CodemSpace.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: context.texts.bodyLarge?.copyWith(fontSize: 15)),
                const SizedBox(height: 2),
                Text(body, style: context.texts.bodySmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
