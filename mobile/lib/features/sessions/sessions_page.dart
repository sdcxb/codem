import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../data/models.dart';
import '../../design/components/common.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../../state/app_state.dart';
import '../../utils/format.dart';
import '../hosts/host_sheets.dart';
import '../hosts/local_host_sheet.dart';

class SessionsPage extends StatelessWidget {
  const SessionsPage({super.key, required this.state, required this.onOpenSession});

  final CodemAppState state;
  final ValueChanged<SessionSummary> onOpenSession;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return SafeArea(
      bottom: false,
      child: ListenableBuilder(
        listenable: state,
        builder: (context, _) {
          final sessions = state.visibleSessions;
          final projects = _projectNames();
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(CodemSpace.xl, CodemSpace.md, CodemSpace.lg, CodemSpace.sm),
                child: Row(
                  children: [
                    const CodemMark(size: 28),
                    const SizedBox(width: CodemSpace.sm),
                    Text(
                      'Codem',
                      style: context.texts.headlineSmall?.copyWith(fontSize: 24),
                    ),
                    const Spacer(),
                    HostPill(
                      name: state.activeHost?.name ?? '未连接',
                      online: state.connected,
                      onTap: () => showHostsSheet(context, state),
                    ),
                  ],
                ),
              ),
              if (state.demo)
                Padding(
                  padding: const EdgeInsets.fromLTRB(CodemSpace.xl, 0, CodemSpace.xl, CodemSpace.sm),
                  child: _DemoBanner(
                    onTap: () => showHostsSheet(context, state),
                  ),
                ),
              if (!state.connected && !state.demo && state.localHostNeedsStart)
                Padding(
                  padding: const EdgeInsets.fromLTRB(CodemSpace.xl, 0, CodemSpace.xl, CodemSpace.sm),
                  child: _LocalHostBanner(
                    message: state.localHostError,
                    onTap: () => showLocalHostSheet(context, state),
                  ),
                ),
              if (state.error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(CodemSpace.xl, 0, CodemSpace.xl, CodemSpace.sm),
                  child: _ErrorBanner(
                    message: state.error!,
                    onRetry: state.retry,
                    onClose: state.clearError,
                  ),
                ),
              SizedBox(
                height: 44,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: CodemSpace.xl),
                  children: [
                    _ProjectChip(
                      label: '全部',
                      selected: state.projectFilter == null,
                      onTap: () => state.setProjectFilter(null),
                    ),
                    for (final project in projects)
                      _ProjectChip(
                        label: project.name,
                        selected: state.projectFilter == project.id,
                        onTap: () => state.setProjectFilter(project.id),
                      ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(CodemSpace.xl, CodemSpace.md, CodemSpace.xl, CodemSpace.sm),
                child: Row(
                  children: [
                    Text('最近', style: context.texts.titleMedium?.copyWith(fontSize: 16)),
                    const SizedBox(width: CodemSpace.sm),
                    MonoText('${sessions.length}', size: 11),
                    const Spacer(),
                    IconButton(
                      onPressed: () => showHostsSheet(context, state),
                      tooltip: '主机',
                      icon: Icon(LucideIcons.monitorSmartphone, size: 18, color: palette.textSecondary),
                      constraints: const BoxConstraints(minWidth: CodemSize.touch, minHeight: CodemSize.touch),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: Stack(
                  children: [
                    if (sessions.isEmpty)
                      const EmptyState(
                        icon: LucideIcons.messageSquare,
                        title: '还没有会话',
                        body: '在 PC 上开一个会话，或者点下方“新会话”。',
                      )
                    else
                      ListView.separated(
                        padding: const EdgeInsets.only(bottom: 92),
                        itemCount: sessions.length,
                        separatorBuilder: (_, _) => Divider(
                          height: 1,
                          indent: 30,
                          endIndent: CodemSpace.lg,
                          color: palette.hairline,
                        ),
                        itemBuilder: (context, index) {
                          final session = sessions[index];
                          return SessionRow(
                            title: session.title,
                            subtitle:
                                '${session.projectName ?? (session.projectId.isEmpty ? '全局' : session.projectId)} · ${session.messageCount} 条',
                            time: relativeTime(session.lastMessageAt),
                            active: state.currentSession?.id == session.id,
                            running: session.running,
                            onTap: () => onOpenSession(session),
                          );
                        },
                      ),
                    Positioned(
                      left: CodemSpace.xl,
                      right: CodemSpace.xl,
                      bottom: CodemSpace.lg,
                      child: _NewSessionButton(
                        onTap: () => _newSession(context),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  List<ProjectSummary> _projectNames() {
    final byId = <String, ProjectSummary>{};
    for (final p in state.projects) {
      byId[p.id] = p;
    }
    for (final s in state.sessions) {
      if (s.projectId.isNotEmpty) {
        byId.putIfAbsent(
          s.projectId,
          () => ProjectSummary(
            id: s.projectId,
            name: s.projectName ?? s.projectId,
          ),
        );
      }
    }
    return byId.values.toList();
  }

  Future<void> _newSession(BuildContext context) async {
    try {
      final session = await state.createSession();
      onOpenSession(session);
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('新建会话失败：$e')));
    }
  }
}

class _DemoBanner extends StatelessWidget {
  const _DemoBanner({required this.onTap});

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
          padding: const EdgeInsets.symmetric(horizontal: CodemSpace.md, vertical: CodemSpace.sm),
          decoration: BoxDecoration(
            color: palette.accent.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(CodemRadius.sm),
            border: Border.all(color: palette.accent.withValues(alpha: 0.18)),
          ),
          child: Row(
            children: [
              Icon(LucideIcons.sparkles, size: 14, color: palette.accent),
              const SizedBox(width: CodemSpace.sm),
              Expanded(
                child: Text(
                  '当前是演示数据 · 点这里连接电脑',
                  style: context.texts.labelSmall?.copyWith(fontSize: 12, color: palette.accent),
                ),
              ),
              Icon(LucideIcons.chevronRight, size: 14, color: palette.accent),
            ],
          ),
        ),
      ),
    );
  }
}

/// 有本机 Host 配置但没启动时的入口条：点开配置面板启动，而不是报错。
class _LocalHostBanner extends StatelessWidget {
  const _LocalHostBanner({required this.onTap, this.message});

  final VoidCallback onTap;
  final String? message;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(CodemRadius.sm),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: CodemSpace.md, vertical: CodemSpace.sm),
          decoration: BoxDecoration(
            color: palette.accent.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(CodemRadius.sm),
            border: Border.all(color: palette.accent.withValues(alpha: 0.18)),
          ),
          child: Row(
            children: [
              Icon(LucideIcons.smartphone, size: 15, color: palette.accent),
              const SizedBox(width: CodemSpace.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '启动本机 Host',
                      style: context.texts.labelSmall?.copyWith(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: palette.accent,
                      ),
                    ),
                    if (message != null)
                      Text(
                        message!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.texts.labelSmall?.copyWith(fontSize: 11),
                      ),
                  ],
                ),
              ),
              Icon(LucideIcons.chevronRight, size: 14, color: palette.accent),
            ],
          ),
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message, required this.onRetry, required this.onClose});

  final String message;
  final VoidCallback onRetry;
  final VoidCallback onClose;

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
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: context.texts.bodySmall?.copyWith(color: palette.danger),
            ),
          ),
          TextButton(
            onPressed: onRetry,
            style: TextButton.styleFrom(foregroundColor: palette.danger),
            child: const Text('重试'),
          ),
          IconButton(
            onPressed: onClose,
            icon: Icon(LucideIcons.x, size: 16, color: palette.danger),
            constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
          ),
        ],
      ),
    );
  }
}

class _ProjectChip extends StatelessWidget {
  const _ProjectChip({required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Padding(
      padding: const EdgeInsets.only(right: CodemSpace.sm),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(CodemRadius.sm),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: CodemSpace.md, vertical: CodemSpace.sm),
            decoration: BoxDecoration(
              color: selected ? palette.accent.withValues(alpha: 0.12) : palette.surface,
              borderRadius: BorderRadius.circular(CodemRadius.sm),
              border: Border.all(color: selected ? palette.accent.withValues(alpha: 0.35) : palette.hairline),
            ),
            child: Row(
              children: [
                Icon(LucideIcons.folder, size: 13, color: selected ? palette.accent : palette.textSecondary),
                const SizedBox(width: 5),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 140),
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: kCodemSans,
                      fontSize: 12,
                      height: 1.3,
                      color: selected ? palette.accent : palette.textSecondary,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _NewSessionButton extends StatelessWidget {
  const _NewSessionButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(CodemRadius.full),
        child: Container(
          height: CodemSize.button,
          decoration: BoxDecoration(
            color: palette.accent,
            borderRadius: BorderRadius.circular(CodemRadius.full),
            boxShadow: [
              BoxShadow(
                color: palette.accent.withValues(alpha: 0.25),
                blurRadius: 16,
                offset: const Offset(0, 6),
              ),
            ],
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(LucideIcons.plus, size: 18, color: Colors.white),
              const SizedBox(width: CodemSpace.sm),
              Text(
                '新会话',
                style: context.texts.labelLarge?.copyWith(color: Colors.white, fontSize: 14),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
