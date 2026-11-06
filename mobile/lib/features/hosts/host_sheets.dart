import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../data/models.dart';
import '../../design/components/common.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../../platform/local_host.dart';
import '../../state/app_state.dart';
import '../../utils/format.dart';
import 'local_host_sheet.dart';

Future<void> showHostsSheet(BuildContext context, CodemAppState state) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _HostsSheet(state: state),
  );
}

class _HostsSheet extends StatelessWidget {
  const _HostsSheet({required this.state});

  final CodemAppState state;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) => Container(
        decoration: BoxDecoration(
          color: palette.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(CodemRadius.sheet)),
          border: Border(top: BorderSide(color: palette.hairline)),
        ),
        padding: const EdgeInsets.fromLTRB(CodemSpace.lg, CodemSpace.md, CodemSpace.lg, CodemSpace.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 34,
                height: 4,
                decoration: BoxDecoration(
                  color: palette.hairline,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: CodemSpace.lg),
            Row(
              children: [
                Text('主机', style: context.texts.titleMedium),
                const Spacer(),
                if (state.demo)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: CodemSpace.sm, vertical: 4),
                    decoration: BoxDecoration(
                      color: palette.accent.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(CodemRadius.sm),
                    ),
                    child: Text('演示数据', style: context.texts.labelSmall?.copyWith(color: palette.accent)),
                  ),
              ],
            ),
            const SizedBox(height: CodemSpace.md),
            if (state.hosts.isEmpty)
              Text('还没有添加主机。可以连接电脑，或直接在这台手机上运行本机 Host。',
                  style: context.texts.bodySmall),
            for (final host in state.hosts) ...[
              _HostRow(
                host: host,
                active: host.id == state.activeHost?.id,
                online: host.kind == HostKind.local ? state.localHostStatus.running : host.online,
                subtitle: _hostSubtitle(state, host),
                onTap: () async {
                  Navigator.of(context).pop();
                  if (host.kind == HostKind.local &&
                      !(state.connected && state.activeHost?.id == host.id)) {
                    // 本机 Host 没运行时点它应去「启动」，而不是直接撞连接失败。
                    await showLocalHostSheet(context, state);
                  } else {
                    await state.connect(host);
                  }
                },
                onDelete: () async {
                  await state.removeHost(host);
                },
              ),
              const SizedBox(height: CodemSpace.sm),
            ],
            if (LocalHostBridge.platformSupported && state.localHostProfile == null) ...[
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: () {
                    Navigator.of(context).pop();
                    showLocalHostSheet(context, state);
                  },
                  icon: Icon(LucideIcons.smartphone, size: 16, color: palette.accent),
                  label: const Text('本机运行（Android）'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: palette.accent,
                    side: BorderSide(color: palette.accent.withValues(alpha: 0.35)),
                    minimumSize: const Size(0, CodemSize.button),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(CodemRadius.sm),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: CodemSpace.sm),
            ],
            const SizedBox(height: CodemSpace.sm),
            PrimaryButton(
              label: '添加电脑',
              icon: LucideIcons.plus,
              expanded: true,
              onPressed: () {
                Navigator.of(context).pop();
                showAddHostSheet(context, state);
              },
            ),
            const SizedBox(height: CodemSpace.sm),
            Text(
              '本机 Host 直接跑在手机上；Tailscale Serve 入口可免码连接，Funnel 公网入口仍需配对码。',
              style: context.texts.labelSmall?.copyWith(fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }
}

class _HostRow extends StatelessWidget {
  const _HostRow({
    required this.host,
    required this.active,
    required this.online,
    required this.subtitle,
    required this.onTap,
    required this.onDelete,
  });

  final HostProfile host;
  final bool active;

  /// 本机 Host 用原生 status 判断，不沿用上次持久化的 online。
  final bool online;
  final String subtitle;
  final VoidCallback onTap;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      decoration: BoxDecoration(
        color: active ? palette.accent.withValues(alpha: 0.06) : palette.surfaceRaised,
        borderRadius: BorderRadius.circular(CodemRadius.md),
        border: Border.all(color: active ? palette.accent.withValues(alpha: 0.35) : palette.hairline),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(CodemRadius.md),
        onTap: onTap,
        child: SizedBox(
          height: 64,
          child: Row(
            children: [
              const SizedBox(width: CodemSpace.md),
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: online ? palette.success : palette.textSecondary,
                ),
              ),
              const SizedBox(width: CodemSpace.md),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(untrusted(host.name), style: context.texts.titleMedium?.copyWith(fontSize: 15)),
                    const SizedBox(height: 2),
                    MonoText(subtitle, size: 11, maxLines: 1),
                  ],
                ),
              ),
              if (host.lastSeenAt != null)
                MonoText(relativeTime(host.lastSeenAt!), size: 10),
              IconButton(
                onPressed: onDelete,
                tooltip: '删除主机',
                icon: Icon(LucideIcons.trash2, size: 18, color: palette.textSecondary),
                constraints: const BoxConstraints(minWidth: CodemSize.touch, minHeight: CodemSize.touch),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 本机 Host 行显示运行状态；远程仍显示地址。
String _hostSubtitle(CodemAppState state, HostProfile host) {
  if (host.kind != HostKind.local) return host.baseUrl;
  if (!state.localHostStatus.running) return '本机 Host · 未运行';
  return state.localHostStatus.shared == false ? '本机 · 运行中（私有目录）' : '本机 · 运行中';
}

Future<void> showAddHostSheet(BuildContext context, CodemAppState state) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _AddHostSheet(state: state),
  );
}

class _AddHostSheet extends StatefulWidget {
  const _AddHostSheet({required this.state});

  final CodemAppState state;

  @override
  State<_AddHostSheet> createState() => _AddHostSheetState();
}

class _AddHostSheetState extends State<_AddHostSheet> {
  final _name = TextEditingController();
  final _url = TextEditingController();
  final _code = TextEditingController();
  bool _busy = false;
  bool _local = false;

  @override
  void dispose() {
    _name.dispose();
    _url.dispose();
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: Container(
        decoration: BoxDecoration(
          color: palette.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(CodemRadius.sheet)),
          border: Border(top: BorderSide(color: palette.hairline)),
        ),
        padding: const EdgeInsets.fromLTRB(CodemSpace.lg, CodemSpace.lg, CodemSpace.lg, CodemSpace.lg),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('添加主机', style: context.texts.titleMedium),
              if (LocalHostBridge.platformSupported) ...[
                const SizedBox(height: CodemSpace.md),
                Row(
                  children: [
                    Expanded(
                      child: _ModeChip(
                        label: '远程电脑',
                        icon: LucideIcons.monitorSmartphone,
                        selected: !_local,
                        onTap: () => setState(() => _local = false),
                      ),
                    ),
                    const SizedBox(width: CodemSpace.sm),
                    Expanded(
                      child: _ModeChip(
                        label: '本机运行（Android）',
                        icon: LucideIcons.smartphone,
                        selected: _local,
                        onTap: () => setState(() => _local = true),
                      ),
                    ),
                  ],
                ),
              ],
              const SizedBox(height: CodemSpace.lg),
              if (_local) ..._localBody(context) else ..._remoteBody(context),
            ],
          ),
        ),
      ),
    );
  }

  /// 本机 Host：不需要 URL/配对码，直接进模型配置面板。
  List<Widget> _localBody(BuildContext context) {
    return [
      Text(
        'Codem Host 直接跑在这台手机上，不需要电脑、地址或配对码。'
        '模型配置只保存在本机，连接走 127.0.0.1。',
        style: context.texts.bodySmall,
      ),
      const SizedBox(height: CodemSpace.lg),
      PrimaryButton(
        label: '配置并启动本机 Host',
        icon: LucideIcons.smartphone,
        expanded: true,
        onPressed: () {
          Navigator.of(context).pop();
          showLocalHostSheet(context, widget.state);
        },
      ),
    ];
  }

  /// 远程主机：保留原来的地址 + 配对码流程。
  List<Widget> _remoteBody(BuildContext context) {
    return [
      Text(
        'Tailscale Serve 地址可直接连接，无需配对码；Funnel/公网才需要配对码。',
        style: context.texts.bodySmall,
      ),
      const SizedBox(height: CodemSpace.lg),
      TextField(
        controller: _name,
        decoration: const InputDecoration(hintText: '名称（可选，例如 工作室 PC）'),
        textInputAction: TextInputAction.next,
      ),
      const SizedBox(height: CodemSpace.md),
      TextField(
        controller: _url,
        decoration: const InputDecoration(
          hintText: '粘贴认领链接，或 https://<pc>.<tailnet>.ts.net',
        ),
        keyboardType: TextInputType.url,
        autocorrect: false,
        textInputAction: TextInputAction.next,
      ),
      const SizedBox(height: CodemSpace.md),
      TextField(
        controller: _code,
        decoration: const InputDecoration(hintText: '配对码（可选，6 位数字）'),
        keyboardType: TextInputType.number,
        textInputAction: TextInputAction.done,
      ),
      const SizedBox(height: CodemSpace.lg),
      PrimaryButton(
        label: _busy ? '连接中…' : '添加并连接',
        expanded: true,
        onPressed: _busy
            ? null
            : () async {
                setState(() => _busy = true);
                final target = parseHostInput(_url.text);
                await widget.state.addHost(
                  name: _name.text,
                  baseUrl: target.baseUrl,
                  kind: HostKind.remote,
                  pairCode: _code.text.trim().isEmpty ? target.code : _code.text,
                );
                if (!context.mounted) return;
                setState(() => _busy = false);
                if (widget.state.error != null) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(widget.state.error!)),
                  );
                  widget.state.clearError();
                } else {
                  Navigator.of(context).pop();
                }
              },
      ),
    ];
  }
}

/// 添加主机面板顶部的二选一（远程 / 本机），沿用项目里的 chip 语言。
class _ModeChip extends StatelessWidget {
  const _ModeChip({
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(CodemRadius.sm),
        child: Container(
          height: 48,
          padding: const EdgeInsets.symmetric(horizontal: CodemSpace.sm),
          decoration: BoxDecoration(
            color: selected ? palette.accent.withValues(alpha: 0.12) : palette.surfaceRaised,
            borderRadius: BorderRadius.circular(CodemRadius.sm),
            border: Border.all(
              color: selected ? palette.accent.withValues(alpha: 0.35) : palette.hairline,
            ),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 15, color: selected ? palette.accent : palette.textSecondary),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.texts.labelMedium?.copyWith(
                    fontSize: 12,
                    color: selected ? palette.accent : palette.textSecondary,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Host 名称来自远程，渲染前做最小清洗（不执行 HTML，Flutter Text 天然安全；
/// 这里只折叠控制字符，避免换行破坏布局）。
String untrusted(String value) {
  return value.replaceAll(RegExp(r'[\u0000-\u001f]'), ' ').trim();
}

/// 接受三种输入，尽量做到“只粘一条链接”：
/// - `https://host.tailnet.ts.net/pair?code=123456`
/// - `codem://pair?host=https%3A%2F%2Fhost...&code=123456`
/// - 裸地址 `host.tailnet.ts.net` 或 `https://host.tailnet.ts.net`
({String baseUrl, String? code}) parseHostInput(String raw) {
  final input = raw.trim();
  if (input.isEmpty) return (baseUrl: '', code: null);
  final uri = Uri.tryParse(input);
  if (uri == null) return (baseUrl: input, code: null);

  String? code = uri.queryParameters['code'] ?? uri.queryParameters['pair'] ?? uri.queryParameters['token'];
  String? hostOverride = uri.queryParameters['host'] ?? uri.queryParameters['url'];

  if (uri.scheme == 'codem') {
    final host = hostOverride ?? '';
    return (baseUrl: host, code: code);
  }

  if (uri.scheme == 'http' || uri.scheme == 'https') {
    final base = Uri(
      scheme: uri.scheme,
      host: uri.host,
      port: uri.hasPort ? uri.port : null,
    ).toString();
    return (baseUrl: base, code: code);
  }

  // 用户只输入了主机名（没有 scheme）：默认 https。
  if (!input.contains('://')) {
    return (baseUrl: 'https://$input', code: code);
  }
  return (baseUrl: input, code: code);
}
