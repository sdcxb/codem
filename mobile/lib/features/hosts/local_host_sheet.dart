import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../design/components/common.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../../platform/local_host.dart';
import '../../state/app_state.dart';

/// 本机 Host 编辑页：模型服务地址 / 模型名 / API Key（隐藏输入）/ 当前项目 / 启动停止。
///
/// 只有 Android 会展示入口（[LocalHostBridge.platformSupported]）。启动成功后
/// `CodemAppState.startLocalHost` 会把 loopback url + token 落成
/// `HostProfile(kind: local)` 并直接连接，所以这里成功后关掉面板即可。
Future<void> showLocalHostSheet(BuildContext context, CodemAppState state) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _LocalHostSheet(state: state),
  );
}

class _LocalHostSheet extends StatefulWidget {
  const _LocalHostSheet({required this.state});

  final CodemAppState state;

  @override
  State<_LocalHostSheet> createState() => _LocalHostSheetState();
}

class _LocalHostSheetState extends State<_LocalHostSheet> with WidgetsBindingObserver {
  final _baseUrl = TextEditingController(text: LocalHostConfig.defaultBaseUrl);
  final _model = TextEditingController(text: LocalHostConfig.defaultModel);
  final _apiKey = TextEditingController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _baseUrl.dispose();
    _model.dispose();
    _apiKey.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycleState) {
    // 去系统授权页回来后复查，已可写就自动重试启动。
    if (lifecycleState == AppLifecycleState.resumed) _recheckStorageAccess();
  }

  Future<void> _load() async {
    final state = widget.state;
    await state.refreshLocalModel();
    await state.refreshLocalProjects();
    await state.refreshLocalHostStatus();
    if (state.localHostNeedsPermission) {
      await state.refreshLocalHostStorageAccess();
    }
    if (!mounted) return;
    final config = state.localModel;
    if (config.baseUrl.trim().isNotEmpty) _baseUrl.text = config.baseUrl;
    if (config.model.trim().isNotEmpty) _model.text = config.model;
    // 触发 Dropdown 的 initialValue 同步。
    setState(() {});
  }

  Future<void> _start({bool allowPrivateFallback = false}) async {
    if (widget.state.localHostBusy) return;
    FocusScope.of(context).unfocus();
    final ok = await widget.state.startLocalHost(
      baseUrl: _baseUrl.text,
      model: _model.text,
      apiKey: _apiKey.text,
      allowPrivateFallback: allowPrivateFallback,
    );
    if (!mounted) return;
    if (ok) {
      _apiKey.clear();
      Navigator.of(context).pop();
    }
  }

  Future<void> _stop() async {
    if (widget.state.localHostBusy) return;
    await widget.state.stopLocalHost();
    if (!mounted) return;
    Navigator.of(context).pop();
  }

  Future<void> _saveOnly() async {
    if (widget.state.localHostBusy) return;
    FocusScope.of(context).unfocus();
    final ok = await widget.state.saveLocalModel(
      baseUrl: _baseUrl.text,
      model: _model.text,
      apiKey: _apiKey.text,
    );
    if (!mounted) return;
    if (ok) _apiKey.clear();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(ok ? '模型配置已保存到本机' : (widget.state.localHostError ?? '保存失败，请重试')),
      ),
    );
  }

  Future<void> _requestStorageAccess() async {
    if (widget.state.localHostBusy) return;
    final granted = await widget.state.requestLocalHostStorageAccess();
    if (!mounted) return;
    if (granted) {
      // 原生返回 true = 现在已经可写，直接重试启动。
      await _start();
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('已打开系统授权页：授权后回到 Codem 会自动复查并重试。')),
    );
  }

  /// 从系统授权页回到 App 后复查；拿到权限且手上还有 Key 就自动重试启动。
  Future<void> _recheckStorageAccess() async {
    final state = widget.state;
    if (!state.localHostNeedsPermission || state.localHostStatus.running) return;
    final granted = await state.refreshLocalHostStorageAccess();
    if (!mounted || !granted) return;
    if (_apiKey.text.trim().isEmpty && !state.localModel.hasKey) {
      // 没有 Key 可重试：留在面板让用户补填。
      setState(() {});
      return;
    }
    await _start();
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    final maxHeight = MediaQuery.sizeOf(context).height * 0.9;
    return Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: Container(
        constraints: BoxConstraints(maxHeight: maxHeight),
        decoration: BoxDecoration(
          color: palette.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(CodemRadius.sheet)),
          border: Border(top: BorderSide(color: palette.hairline)),
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(CodemSpace.lg, CodemSpace.md, CodemSpace.lg, CodemSpace.lg),
          child: ListenableBuilder(
            listenable: widget.state,
            builder: (context, _) => _body(context),
          ),
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final palette = context.palette;
    final state = widget.state;
    final status = state.localHostStatus;
    final running = status.running;
    final busy = state.localHostBusy;
    final hasKey = state.localModel.hasKey;
    final names = <String>[
      '',
      ...state.localProjects.where((name) => name.isNotEmpty),
    ];
    final currentProject = state.localProject ?? '';
    final selectedProject = names.contains(currentProject) ? currentProject : '';

    return Column(
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
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: palette.accent.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(CodemRadius.sm),
              ),
              child: Icon(LucideIcons.smartphone, size: 18, color: palette.accent),
            ),
            const SizedBox(width: CodemSpace.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('本机 Host', style: context.texts.titleMedium),
                  const SizedBox(height: 2),
                  Text(
                    'Host 直接跑在这台手机上，不需要电脑',
                    style: context.texts.labelSmall?.copyWith(fontSize: 11),
                  ),
                ],
              ),
            ),
            _StatusChip(running: running, busy: busy),
          ],
        ),
        const SizedBox(height: CodemSpace.lg),
        const _FieldLabel('模型服务地址'),
        TextField(
          controller: _baseUrl,
          keyboardType: TextInputType.url,
          autocorrect: false,
          textInputAction: TextInputAction.next,
          decoration: const InputDecoration(hintText: 'https://api.aicodewith.ai/v1'),
        ),
        const SizedBox(height: CodemSpace.md),
        const _FieldLabel('模型名'),
        TextField(
          controller: _model,
          autocorrect: false,
          textInputAction: TextInputAction.next,
          decoration: const InputDecoration(hintText: 'deepseek-v4-flash'),
        ),
        const SizedBox(height: CodemSpace.md),
        const _FieldLabel('API Key'),
        TextField(
          controller: _apiKey,
          obscureText: true,
          autocorrect: false,
          enableSuggestions: false,
          textInputAction: TextInputAction.done,
          decoration: InputDecoration(
            hintText: hasKey ? '已保存，留空则沿用' : 'sk-…',
          ),
        ),
        const SizedBox(height: CodemSpace.xs),
        Text(
          hasKey
              ? 'Key 只保存在这台手机上，不进日志；留空沿用上次保存的值。'
              : 'Key 只保存在这台手机上，不会上传到 Codem 服务器。',
          style: context.texts.labelSmall?.copyWith(fontSize: 11),
        ),
        if (state.localModel.keyState == 'unreadable')
          Padding(
            padding: const EdgeInsets.only(top: CodemSpace.xs),
            child: Text(
              '上次保存的 Key 无法解密（可能换过设备密钥），请重新输入。',
              style: context.texts.labelSmall?.copyWith(fontSize: 11, color: palette.danger),
            ),
          ),
        if (state.localModel.insecureHttp)
          Padding(
            padding: const EdgeInsets.only(top: CodemSpace.xs),
            child: Text(
              '模型服务地址不是 https：Key 会按明文 HTTP 发送，建议换成 https 地址。',
              style: context.texts.labelSmall?.copyWith(fontSize: 11, color: palette.warning),
            ),
          ),
        const SizedBox(height: CodemSpace.md),
        Row(
          children: [
            const _FieldLabel('当前项目'),
            const Spacer(),
            IconButton(
              onPressed: busy ? null : () => state.refreshLocalProjects(),
              tooltip: '刷新项目',
              icon: Icon(LucideIcons.refreshCw, size: 16, color: palette.textSecondary),
              constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
            ),
          ],
        ),
        DropdownButtonFormField<String>(
          initialValue: selectedProject,
          isExpanded: true,
          decoration: const InputDecoration(hintText: '工作区根目录'),
          items: [
            const DropdownMenuItem<String>(value: '', child: Text('工作区根目录')),
            for (final name in names.where((name) => name.isNotEmpty))
              DropdownMenuItem<String>(value: name, child: Text(_displayName(name))),
          ],
          onChanged: busy ? null : (value) => state.setLocalProject(value ?? ''),
        ),
        if (running) ...[
          const SizedBox(height: CodemSpace.md),
          _WorkspaceCard(status: status),
        ],
        if (state.localHostNeedsPermission) ...[
          const SizedBox(height: CodemSpace.md),
          _PermissionCard(
            message: state.localHostError ?? permissionMessage(''),
            canRequest: state.localHostCanRequestStorage,
            busy: busy,
            onRequest: _requestStorageAccess,
            onFallback: () => _start(allowPrivateFallback: true),
          ),
        ] else if (state.localHostError != null) ...[
          const SizedBox(height: CodemSpace.md),
          _LocalHostErrorCard(
            message: state.localHostError!,
            onRetry: busy ? null : () => _start(),
          ),
        ],
        const SizedBox(height: CodemSpace.lg),
        if (running) ...[
          PrimaryButton(
            label: busy ? '停止中…' : '停止本机 Host',
            icon: LucideIcons.square,
            expanded: true,
            onPressed: busy ? null : _stop,
          ),
          const SizedBox(height: CodemSpace.sm),
          Center(
            child: TextButton(
              onPressed: busy
                  ? null
                  : () {
                      final host = state.localHostProfile;
                      if (host != null) state.connect(host);
                    },
              child: const Text('重新连接'),
            ),
          ),
        ] else ...[
          PrimaryButton(
            label: busy ? '启动中…' : '启动并连接',
            icon: LucideIcons.play,
            expanded: true,
            onPressed: busy ? null : () => _start(),
          ),
          const SizedBox(height: CodemSpace.sm),
          Row(
            children: [
              Expanded(
                child: TextButton(
                  onPressed: busy ? null : _saveOnly,
                  child: const Text('仅保存模型配置'),
                ),
              ),
              Expanded(
                child: TextButton(
                  onPressed: busy ? null : () => _start(allowPrivateFallback: true),
                  child: const Text('私有工作区启动'),
                ),
              ),
            ],
          ),
        ],
        const SizedBox(height: CodemSpace.sm),
        Text(
          '首次启动要解压运行环境、安装 Node 依赖，可能需要几分钟；之后启动会快很多。',
          style: context.texts.labelSmall?.copyWith(fontSize: 11),
        ),
      ],
    );
  }
}

class _FieldLabel extends StatelessWidget {
  const _FieldLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: CodemSpace.xs, bottom: CodemSpace.xs),
      child: Text(
        text,
        style: context.texts.labelMedium?.copyWith(fontSize: 12, letterSpacing: 0.2),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.running, required this.busy});

  final bool running;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final (color, label) = busy
        ? (palette.textSecondary, '处理中')
        : running
            ? (palette.success, '运行中')
            : (palette.textSecondary, '未运行');
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: CodemSpace.sm, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(CodemRadius.sm),
        border: Border.all(color: color.withValues(alpha: 0.25)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text(label, style: context.texts.labelSmall?.copyWith(fontSize: 11, color: color)),
        ],
      ),
    );
  }
}

class _WorkspaceCard extends StatelessWidget {
  const _WorkspaceCard({required this.status});

  final LocalHostStatus status;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final shared = status.shared;
    final (tag, tagColor) = shared == false
        ? ('私有目录', palette.warning)
        : shared == true
            ? ('共享存储', palette.success)
            : ('', palette.textSecondary);
    return Container(
      padding: const EdgeInsets.all(CodemSpace.md),
      decoration: BoxDecoration(
        color: palette.surfaceRaised,
        borderRadius: BorderRadius.circular(CodemRadius.sm),
        border: Border.all(color: palette.hairline),
      ),
      child: Row(
        children: [
          Icon(LucideIcons.folder, size: 16, color: palette.textSecondary),
          const SizedBox(width: CodemSpace.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                MonoText(status.url, size: 11),
                if (status.workspace.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  MonoText(status.workspace, size: 11, maxLines: 2),
                ],
              ],
            ),
          ),
          if (tag.isNotEmpty) ...[
            const SizedBox(width: CodemSpace.sm),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: tagColor.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(tag, style: context.texts.labelSmall?.copyWith(fontSize: 10, color: tagColor)),
            ),
          ],
        ],
      ),
    );
  }
}

class _PermissionCard extends StatelessWidget {
  const _PermissionCard({
    required this.message,
    required this.canRequest,
    required this.busy,
    required this.onRequest,
    required this.onFallback,
  });

  final String message;
  final bool canRequest;
  final bool busy;
  final VoidCallback onRequest;
  final VoidCallback onFallback;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      padding: const EdgeInsets.all(CodemSpace.md),
      decoration: BoxDecoration(
        color: palette.warning.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(CodemRadius.sm),
        border: Border.all(color: palette.warning.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(LucideIcons.shieldAlert, size: 16, color: palette.warning),
              const SizedBox(width: CodemSpace.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '需要存储权限',
                      style: context.texts.labelLarge?.copyWith(fontSize: 13, color: palette.warning),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      message,
                      style: context.texts.bodySmall?.copyWith(fontSize: 12),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: CodemSpace.xs),
          Row(
            children: [
              if (canRequest)
                TextButton(
                  onPressed: busy ? null : onRequest,
                  style: TextButton.styleFrom(foregroundColor: palette.warning),
                  child: const Text('去授权'),
                ),
              TextButton(
                onPressed: busy ? null : onFallback,
                style: TextButton.styleFrom(foregroundColor: palette.warning),
                child: const Text('改用私有工作区'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _LocalHostErrorCard extends StatelessWidget {
  const _LocalHostErrorCard({required this.message, required this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: CodemSpace.md, vertical: CodemSpace.sm),
      decoration: BoxDecoration(
        color: palette.danger.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(CodemRadius.sm),
        border: Border.all(color: palette.danger.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          Icon(LucideIcons.alertTriangle, size: 15, color: palette.danger),
          const SizedBox(width: CodemSpace.sm),
          Expanded(
            child: Text(
              message,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: context.texts.bodySmall?.copyWith(fontSize: 12, color: palette.danger),
            ),
          ),
          TextButton(
            onPressed: onRetry,
            style: TextButton.styleFrom(foregroundColor: palette.danger),
            child: const Text('重试'),
          ),
        ],
      ),
    );
  }
}

/// 项目名来自手机文件系统：折叠控制字符，避免换行破坏布局。
String _displayName(String value) {
  return value.replaceAll(RegExp(r'[\u0000-\u001f]'), ' ').trim();
}
