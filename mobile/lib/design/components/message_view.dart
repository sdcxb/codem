import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../data/models.dart';
import '../../utils/format.dart';
import '../theme.dart';
import '../tokens.dart';
import 'common.dart';

class MessageView extends StatelessWidget {
  const MessageView({
    super.key,
    required this.message,
    required this.showAvatar,
  });

  final ChatMessage message;
  final bool showAvatar;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    if (message.isUser) {
      return Padding(
        padding: const EdgeInsets.only(top: CodemSpace.xl, bottom: CodemSpace.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Container(
              constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.84),
              padding: const EdgeInsets.symmetric(horizontal: CodemSpace.lg, vertical: CodemSpace.md),
              decoration: BoxDecoration(
                color: palette.userBubble,
                borderRadius: BorderRadius.circular(CodemRadius.input),
                border: Border.all(color: palette.accent.withValues(alpha: 0.16)),
              ),
              child: Text(
                message.content,
                style: context.texts.bodyLarge?.copyWith(color: palette.textPrimary),
              ),
            ),
            const SizedBox(height: 4),
            MonoText(relativeTime(message.timestamp), size: 11),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.only(top: CodemSpace.xl, bottom: CodemSpace.sm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (showAvatar)
            Container(
              width: 26,
              height: 26,
              margin: const EdgeInsets.only(top: 2, right: CodemSpace.sm),
              decoration: BoxDecoration(
                color: palette.accent.withValues(alpha: 0.14),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Center(
                child: Text(
                  'C',
                  style: context.texts.labelLarge?.copyWith(
                    color: palette.accent,
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            )
          else
            const SizedBox(width: 34),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      'Codem',
                      style: context.texts.labelLarge?.copyWith(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: palette.textSecondary,
                      ),
                    ),
                    const SizedBox(width: CodemSpace.sm),
                    MonoText(relativeTime(message.timestamp), size: 11),
                  ],
                ),
                if (message.reasoning != null && message.reasoning!.trim().isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: CodemSpace.sm),
                    child: _Reasoning(text: message.reasoning!),
                  ),
                if (message.content.trim().isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: CodemSpace.sm),
                    child: MarkdownBody(
                      data: message.content,
                      selectable: true,
                      styleSheet: _markdownStyle(context),
                    ),
                  ),
                for (final tool in message.toolCalls)
                  Padding(
                    padding: const EdgeInsets.only(top: CodemSpace.sm),
                    child: ToolCard(tool: tool),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  MarkdownStyleSheet _markdownStyle(BuildContext context) {
    final palette = context.palette;
    final body = context.texts.bodyLarge!;
    final code = TextStyle(
      fontFamily: kCodemMono,
      fontSize: 13,
      height: 1.5,
      color: palette.textPrimary,
    );
    return MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
      p: body.copyWith(color: palette.textPrimary),
      h1: context.texts.headlineSmall,
      h2: context.texts.titleMedium,
      h3: context.texts.titleMedium?.copyWith(fontSize: 16),
      listBullet: body.copyWith(color: palette.textPrimary),
      blockquote: body.copyWith(color: palette.textSecondary),
      blockquoteDecoration: BoxDecoration(
        border: Border(left: BorderSide(color: palette.accent, width: 2)),
      ),
      code: code,
      codeblockDecoration: BoxDecoration(
        color: palette.codeBg,
        borderRadius: BorderRadius.circular(CodemRadius.sm),
        border: Border.all(color: palette.hairline),
      ),
      codeblockPadding: const EdgeInsets.all(CodemSpace.md),
      horizontalRuleDecoration: BoxDecoration(
        border: Border(top: BorderSide(color: palette.hairline)),
      ),
      a: body.copyWith(color: palette.accent),
    );
  }
}

class _Reasoning extends StatelessWidget {
  const _Reasoning({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: CodemSpace.md, vertical: CodemSpace.sm),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(CodemRadius.sm),
        border: Border.all(color: palette.hairline),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(LucideIcons.sparkles, size: 14, color: palette.textSecondary),
          const SizedBox(width: CodemSpace.sm),
          Expanded(
            child: Text(
              text,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: context.texts.bodySmall?.copyWith(color: palette.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}

class ToolCard extends StatefulWidget {
  const ToolCard({super.key, required this.tool});

  final ToolCallView tool;

  @override
  State<ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<ToolCard> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final tool = widget.tool;
    final running = tool.status == 'running';
    final failed = tool.status == 'error';
    final accent = failed ? palette.danger : (running ? palette.accent : palette.textSecondary);
    final label = _labelFor(tool);
    return Container(
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(CodemRadius.sm),
        border: Border.all(color: palette.hairline),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(CodemRadius.sm),
          onTap: () => setState(() => _open = !_open),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                height: CodemSize.touch,
                child: Row(
                  children: [
                    Container(
                      width: 2,
                      height: 24,
                      margin: const EdgeInsets.only(left: 1),
                      decoration: BoxDecoration(
                        color: running ? accent : Colors.transparent,
                        borderRadius: BorderRadius.circular(1),
                      ),
                    ),
                    const SizedBox(width: CodemSpace.md),
                    Icon(_iconFor(tool.name), size: 16, color: accent),
                    const SizedBox(width: CodemSpace.sm),
                    Expanded(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.texts.labelLarge?.copyWith(
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                          color: palette.textPrimary,
                        ),
                      ),
                    ),
                    if (running)
                      MonoText('运行中', size: 11, color: palette.accent)
                    else if (failed)
                      MonoText('失败', size: 11, color: palette.danger)
                    else
                      MonoText('完成', size: 11),
                    const SizedBox(width: CodemSpace.sm),
                    Icon(_open ? LucideIcons.chevronUp : LucideIcons.chevronDown,
                        size: 16, color: palette.textSecondary),
                    const SizedBox(width: CodemSpace.md),
                  ],
                ),
              ),
              AnimatedCrossFade(
                duration: CodemDuration.fast,
                crossFadeState: _open ? CrossFadeState.showSecond : CrossFadeState.showFirst,
                firstChild: const SizedBox(width: double.infinity),
                secondChild: Container(
                  width: double.infinity,
                  margin: const EdgeInsets.fromLTRB(CodemSpace.md, 0, CodemSpace.md, CodemSpace.md),
                  padding: const EdgeInsets.all(CodemSpace.md),
                  decoration: BoxDecoration(
                    color: palette.codeBg,
                    borderRadius: BorderRadius.circular(CodemRadius.sm),
                    border: Border.all(color: palette.hairline),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (tool.args != null)
                        Text(
                          _formatValue(tool.args),
                          style: TextStyle(
                            fontFamily: kCodemMono,
                            fontSize: 12,
                            height: 1.5,
                            color: palette.textSecondary,
                          ),
                        ),
                      if (tool.result != null) ...[
                        if (tool.args != null) const SizedBox(height: CodemSpace.sm),
                        Text(
                          _formatValue(tool.result),
                          style: TextStyle(
                            fontFamily: kCodemMono,
                            fontSize: 12,
                            height: 1.5,
                            color: failed ? palette.danger : palette.textPrimary,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _labelFor(ToolCallView tool) {
    final args = tool.args;
    String? path;
    String? command;
    if (args is Map) {
      path = (args['path'] ?? args['file_path'] ?? args['filePath'])?.toString();
      command = args['command']?.toString();
    }
    switch (tool.name) {
      case 'bash':
      case 'shell':
        return command == null ? '执行命令' : clipMiddle(command, max: 52);
      case 'edit':
      case 'write':
      case 'write_file':
        return path == null ? '修改文件' : '修改 ${shortPath(path)}';
      case 'read':
      case 'read_file':
        return path == null ? '读取文件' : '读取 ${shortPath(path)}';
      default:
        return path == null ? tool.name : '${tool.name} ${shortPath(path)}';
    }
  }

  static IconData _iconFor(String name) {
    switch (name) {
      case 'bash':
      case 'shell':
        return LucideIcons.terminal;
      case 'edit':
      case 'write':
      case 'write_file':
        return LucideIcons.pencil;
      case 'read':
      case 'read_file':
        return LucideIcons.fileText;
      default:
        return LucideIcons.wrench;
    }
  }

  static String _formatValue(dynamic value) {
    if (value == null) return '';
    if (value is String) return value;
    if (value is Map) {
      final entries = value.entries.take(8).map((e) => '${e.key}: ${e.value}').join('\n');
      return entries;
    }
    return value.toString();
  }
}
