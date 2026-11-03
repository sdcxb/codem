import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../data/models.dart';
import '../../design/components/common.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../../state/app_state.dart';
import '../../utils/format.dart';

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
              Text('还没有添加电脑。添加后可以在这台手机上继续 PC 上的会话。',
                  style: context.texts.bodySmall),
            for (final host in state.hosts) ...[
              _HostRow(
                host: host,
                active: host.id == state.activeHost?.id,
                onTap: () async {
                  Navigator.of(context).pop();
                  await state.connect(host);
                },
                onDelete: () async {
                  await state.removeHost(host);
                },
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
              'Tailscale Serve 入口可直接免码连接；Funnel 公网入口仍需配对码。',
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
    required this.onTap,
    required this.onDelete,
  });

  final HostProfile host;
  final bool active;
  final VoidCallback onTap;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final online = host.online && active ? true : host.online;
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
                    MonoText(
                      host.kind == HostKind.local ? '本机 Host' : host.baseUrl,
                      size: 11,
                      maxLines: 1,
                    ),
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
              Text('添加电脑', style: context.texts.titleMedium),
              const SizedBox(height: CodemSpace.sm),
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
