import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../data/models.dart';
import '../../design/components/approval_card.dart';
import '../../design/components/common.dart';
import '../../design/components/composer.dart';
import '../../design/components/message_view.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../../state/app_state.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({super.key, required this.state, required this.session});

  final CodemAppState state;
  final SessionSummary session;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final ScrollController _scroll = ScrollController();
  int _lastCount = 0;

  @override
  void initState() {
    super.initState();
    widget.state.openSession(widget.session);
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(
        _scroll.position.maxScrollExtent + 80,
        duration: CodemDuration.normal,
        curve: Curves.easeOutCubic,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Scaffold(
      resizeToAvoidBottomInset: true,
      appBar: CodemTopBar(
        leading: GhostIconButton(
          icon: LucideIcons.chevronLeft,
          tooltip: '返回',
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              widget.session.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.texts.titleMedium?.copyWith(fontSize: 16),
            ),
            const SizedBox(height: 1),
            MonoText(widget.session.projectName ?? '全局会话', size: 10),
          ],
        ),
        actions: [
          GhostIconButton(
            icon: LucideIcons.panelRight,
            tooltip: '改动 / 上下文',
            onPressed: () => _showDetails(context),
          ),
          GhostIconButton(
            icon: LucideIcons.moreHorizontal,
            tooltip: '更多',
            onPressed: () => _showMore(context),
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: widget.state,
        builder: (context, _) {
          final state = widget.state;
          if (state.messages.length != _lastCount) {
            _lastCount = state.messages.length;
            _scrollToBottom();
          }
          return Column(
            children: [
              if (state.error != null)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: CodemSpace.lg, vertical: CodemSpace.sm),
                  color: palette.danger.withValues(alpha: 0.08),
                  child: Row(
                    children: [
                      Icon(LucideIcons.alertTriangle, size: 14, color: palette.danger),
                      const SizedBox(width: CodemSpace.sm),
                      Expanded(
                        child: Text(
                          state.error!,
                          style: context.texts.bodySmall?.copyWith(color: palette.danger),
                        ),
                      ),
                      GestureDetector(
                        onTap: state.clearError,
                        child: Icon(LucideIcons.x, size: 15, color: palette.danger),
                      ),
                    ],
                  ),
                ),
              Expanded(
                child: state.messages.isEmpty
                    ? EmptyState(
                        icon: LucideIcons.messageSquare,
                        title: '继续这个会话',
                        body: state.demo
                            ? '这是演示数据；连接 PC 后会显示真实的消息与工具调用。'
                            : '在下面输入消息，开始这一轮。',
                      )
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.fromLTRB(CodemSpace.lg, CodemSpace.xl, CodemSpace.lg, CodemSpace.xl),
                        itemCount: state.messages.length,
                        itemBuilder: (context, index) {
                          final message = state.messages[index];
                          return Center(
                            child: ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: CodemSize.maxReading),
                              child: MessageView(
                                message: message,
                                showAvatar: message.role == 'assistant' &&
                                    (index == 0 || state.messages[index - 1].role != 'assistant'),
                              ),
                            ),
                          );
                        },
                      ),
              ),
              if (state.approval != null)
                ApprovalCard(
                  request: state.approval!,
                  onAllow: () => state.respondApproval(true),
                  onDeny: () => state.respondApproval(false),
                ),
              Composer(
                onSend: state.send,
                onStop: state.stop,
                running: state.running,
                enabled: state.connected || state.demo,
                model: state.activeHost?.kind == HostKind.local && state.localModel.model.isNotEmpty
                    ? state.localModel.model
                    : widget.session.model ?? 'deepseek-flash',
                hint: state.demo ? '演示模式：输入消息试试' : '输入消息…  @ 提及文件 / 命令',
                onAttach: state.attachmentsSupported || state.demo ? state.pickImage : null,
                onMention: () => _comingSoon(context, '@ 文件'),
                attachments: state.attachments,
                onRemoveAttachment: state.removeAttachment,
                statusLine: StatusLine(
                  online: state.connected || state.demo,
                  label: state.demo
                      ? '演示模式 · 数据不出设备'
                      : (state.connected
                          ? '${state.activeHost?.name ?? 'PC'} · 已连接'
                          : '未连接 · 点上方主机重试'),
                  suffix: state.running
                      ? MonoText('运行中', size: 10, color: palette.accent)
                      : MonoText('Enter 发送', size: 10),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  void _comingSoon(BuildContext context, String feature) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$feature 将在后续里程碑开放')),
    );
  }

  void _showMore(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      backgroundColor: context.palette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(CodemRadius.sheet)),
      ),
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(LucideIcons.refreshCw),
              title: const Text('重新加载会话'),
              onTap: () {
                Navigator.pop(context);
                widget.state.openSession(widget.session);
              },
            ),
            ListTile(
              leading: const Icon(LucideIcons.share2),
              title: const Text('分享会话'),
              onTap: () {
                Navigator.pop(context);
                widget.state.shareSession();
              },
            ),
            ListTile(
              leading: const Icon(LucideIcons.trash2),
              title: const Text('关闭并返回'),
              onTap: () {
                Navigator.pop(context);
                Navigator.pop(context);
              },
            ),
            const SizedBox(height: CodemSpace.sm),
          ],
        ),
      ),
    );
  }

  void _showDetails(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _DetailsSheet(state: widget.state),
    );
  }
}

class _DetailsSheet extends StatefulWidget {
  const _DetailsSheet({required this.state});

  final CodemAppState state;

  @override
  State<_DetailsSheet> createState() => _DetailsSheetState();
}

class _DetailsSheetState extends State<_DetailsSheet> {
  @override
  void initState() {
    super.initState();
    widget.state.loadChanges();
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.78),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(CodemRadius.sheet)),
        border: Border(top: BorderSide(color: palette.hairline)),
      ),
      padding: const EdgeInsets.fromLTRB(CodemSpace.lg, CodemSpace.md, CodemSpace.lg, CodemSpace.xl),
      child: ListenableBuilder(
        listenable: widget.state,
        builder: (context, _) {
          final state = widget.state;
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
                  Text('改动 / 上下文', style: context.texts.titleMedium),
                  const Spacer(),
                  MonoText('本轮', size: 10),
                ],
              ),
              const SizedBox(height: CodemSpace.md),
              if (state.changesLoading)
                const Padding(
                  padding: EdgeInsets.all(CodemSpace.xl),
                  child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
                )
              else if (!state.changesSupported)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: CodemSpace.lg),
                  child: Text(
                    state.changesReason ?? '当前工作区不支持改动记录。',
                    style: context.texts.bodySmall,
                  ),
                )
              else if (state.changes.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: CodemSpace.lg),
                  child: Text('本轮还没有文件改动。', style: context.texts.bodySmall),
                )
              else
                Flexible(
                  child: ListView.separated(
                    shrinkWrap: true,
                    itemCount: state.changes.length,
                    separatorBuilder: (_, _) => const SizedBox(height: CodemSpace.sm),
                    itemBuilder: (context, index) {
                      final change = state.changes[index];
                      return Container(
                        decoration: BoxDecoration(
                          color: palette.surfaceRaised,
                          borderRadius: BorderRadius.circular(CodemRadius.md),
                          border: Border.all(color: palette.hairline),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Padding(
                              padding: const EdgeInsets.fromLTRB(CodemSpace.md, CodemSpace.sm, CodemSpace.md, 2),
                              child: Text(
                                change.brief?.isNotEmpty == true ? change.brief! : '第 ${change.turnIndex} 轮改动',
                                style: context.texts.labelMedium?.copyWith(color: palette.textSecondary),
                              ),
                            ),
                            for (final file in change.files)
                              InkWell(
                                onTap: () => _openDiff(context, change, file),
                                child: SizedBox(
                                  height: 44,
                                  child: Row(
                                    children: [
                                      const SizedBox(width: CodemSpace.md),
                                      Expanded(child: MonoText(file.path, size: 12, color: palette.textPrimary)),
                                      MonoText(
                                        '${file.status} +${file.additions ?? '—'} -${file.deletions ?? '—'}',
                                        size: 10,
                                      ),
                                      const SizedBox(width: CodemSpace.md),
                                    ],
                                  ),
                                ),
                              ),
                          ],
                        ),
                      );
                    },
                  ),
                ),
              const SizedBox(height: CodemSpace.md),
              Row(
                children: [
                  Icon(LucideIcons.info, size: 13, color: palette.textSecondary),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '改动来自 PC 的 git 工作区；点文件查看 diff。',
                      style: context.texts.labelSmall?.copyWith(fontSize: 11),
                    ),
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _openDiff(BuildContext context, TurnChanges change, ChangedFile file) async {
    final diff = await widget.state.loadDiff(change, file);
    if (!context.mounted || diff == null) return;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: context.palette.surface,
      builder: (context) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.7,
        maxChildSize: 0.92,
        builder: (context, controller) => Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(CodemSpace.lg),
              child: Row(
                children: [
                  Expanded(child: MonoText(diff.path, color: context.palette.textPrimary)),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(LucideIcons.x, size: 18),
                  ),
                ],
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                controller: controller,
                padding: const EdgeInsets.fromLTRB(CodemSpace.lg, 0, CodemSpace.lg, CodemSpace.xl),
                child: SelectableText(
                  diff.patch.isEmpty ? '没有可显示的 diff。' : diff.patch,
                  style: TextStyle(
                    fontFamily: kCodemMono,
                    fontSize: 12,
                    height: 1.5,
                    color: context.palette.textPrimary,
                  ),
                ),
              ),
            ),
            if (diff.truncated)
              Padding(
                padding: const EdgeInsets.only(bottom: CodemSpace.md),
                child: Text('diff 已截断', style: context.texts.labelSmall),
              ),
          ],
        ),
      ),
    );
  }
}
