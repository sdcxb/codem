import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../design/components/common.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../../state/app_state.dart';
import '../files/workspace_sheet.dart';
import '../hosts/host_sheets.dart';

class ProjectsPage extends StatelessWidget {
  const ProjectsPage({super.key, required this.state});

  final CodemAppState state;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return SafeArea(
      bottom: false,
      child: ListenableBuilder(
        listenable: state,
        builder: (context, _) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(CodemSpace.xl, CodemSpace.md, CodemSpace.lg, CodemSpace.sm),
                child: Row(
                  children: [
                    Text('项目', style: context.texts.headlineSmall?.copyWith(fontSize: 24)),
                    const Spacer(),
                    HostPill(
                      name: state.activeHost?.name ?? '未连接',
                      online: state.connected,
                      onTap: () => showHostsSheet(context, state),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(CodemSpace.xl, CodemSpace.sm, CodemSpace.xl, CodemSpace.lg),
                child: Text(
                  '项目属于当前主机。手机上的会话、文件和改动都直接来自那台电脑。',
                  style: context.texts.bodySmall?.copyWith(color: palette.textSecondary),
                ),
              ),
              Expanded(
                child: state.projects.isEmpty
                    ? EmptyState(
                        icon: LucideIcons.folder,
                        title: '还没有项目',
                        body: '连接电脑后，这里会列出 PC 上的 Codem 项目。',
                        action: PrimaryButton(
                          label: '添加电脑',
                          icon: LucideIcons.plus,
                          onPressed: () => showAddHostSheet(context, state),
                        ),
                      )
                    : ListView.separated(
                        padding: const EdgeInsets.fromLTRB(CodemSpace.xl, 0, CodemSpace.xl, 24),
                        itemCount: state.projects.length,
                        separatorBuilder: (_, _) => const SizedBox(height: CodemSpace.sm),
                        itemBuilder: (context, index) {
                          final project = state.projects[index];
                          return SectionCard(
                            padding: const EdgeInsets.all(CodemSpace.md),
                            onTap: () => showWorkspaceSheet(context, state),
                            child: Row(
                              children: [
                                Container(
                                  width: 36,
                                  height: 36,
                                  decoration: BoxDecoration(
                                    color: palette.accent.withValues(alpha: 0.10),
                                    borderRadius: BorderRadius.circular(CodemRadius.sm),
                                  ),
                                  child: Icon(LucideIcons.folder, size: 18, color: palette.accent),
                                ),
                                const SizedBox(width: CodemSpace.md),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(project.name, style: context.texts.titleMedium?.copyWith(fontSize: 15)),
                                      const SizedBox(height: 2),
                                      MonoText(project.path, size: 11),
                                    ],
                                  ),
                                ),
                                Icon(LucideIcons.chevronRight, size: 16, color: palette.textSecondary),
                              ],
                            ),
                          );
                        },
                      ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(CodemSpace.xl, 0, CodemSpace.xl, CodemSpace.lg),
                child: PrimaryButton(
                  label: '添加电脑',
                  icon: LucideIcons.plus,
                  expanded: true,
                  onPressed: () => showAddHostSheet(context, state),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
