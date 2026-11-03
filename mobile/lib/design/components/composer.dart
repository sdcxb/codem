import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../data/models.dart';
import '../theme.dart';
import '../tokens.dart';
import 'common.dart';

class Composer extends StatefulWidget {
  const Composer({
    super.key,
    required this.onSend,
    required this.onStop,
    required this.running,
    this.enabled = true,
    this.model = 'deepseek-flash',
    this.hint = '输入消息…',
    this.statusLine,
    this.onAttach,
    this.onMention,
    this.attachments = const [],
    this.onRemoveAttachment,
  });

  final ValueChanged<String> onSend;
  final VoidCallback onStop;
  final bool running;
  final bool enabled;
  final String model;
  final String hint;
  final Widget? statusLine;
  final VoidCallback? onAttach;
  final VoidCallback? onMention;
  final List<PendingAttachment> attachments;
  final ValueChanged<PendingAttachment>? onRemoveAttachment;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focus = FocusNode();
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(() {
      final has = _controller.text.trim().isNotEmpty;
      if (has != _hasText) setState(() => _hasText = has);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _send() {
    final text = _controller.text.trim();
    if (text.isEmpty || widget.running || !widget.enabled) return;
    _controller.clear();
    _focus.requestFocus();
    widget.onSend(text);
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      decoration: BoxDecoration(
        color: palette.canvas,
        border: Border(top: BorderSide(color: palette.hairline)),
      ),
      padding: EdgeInsets.only(
        left: CodemSpace.lg,
        right: CodemSpace.lg,
        top: CodemSpace.sm,
        bottom: MediaQuery.viewInsetsOf(context).bottom > 0 ? CodemSpace.sm : CodemSpace.sm + MediaQuery.paddingOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            decoration: BoxDecoration(
              color: palette.surface,
              borderRadius: BorderRadius.circular(CodemRadius.input),
              border: Border.all(color: palette.hairline),
            ),
            padding: const EdgeInsets.fromLTRB(CodemSpace.md, 6, 6, 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (widget.attachments.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(left: 2, top: 4, bottom: 2),
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        for (final attachment in widget.attachments)
                          _AttachmentChip(
                            attachment: attachment,
                            onRemove: widget.onRemoveAttachment == null
                                ? null
                                : () => widget.onRemoveAttachment!(attachment),
                          ),
                      ],
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.only(left: 2, top: 2, bottom: 2),
                  child: Row(
                    children: [
                      _Chip(
                        icon: LucideIcons.folderGit2,
                        label: '当前项目',
                        muted: true,
                      ),
                      const SizedBox(width: CodemSpace.sm),
                      _Chip(
                        icon: LucideIcons.fileCode2,
                        label: '上下文',
                        muted: true,
                      ),
                    ],
                  ),
                ),
                TextField(
                  controller: _controller,
                  focusNode: _focus,
                  minLines: 1,
                  maxLines: 6,
                  enabled: widget.enabled && !widget.running,
                  style: context.texts.bodyLarge?.copyWith(fontSize: 16),
                  decoration: InputDecoration(
                    hintText: widget.hint,
                    filled: false,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 2, vertical: 8),
                  ),
                  textInputAction: TextInputAction.newline,
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    GhostIconButton(
                      icon: LucideIcons.plus,
                      tooltip: '附件',
                      onPressed: widget.enabled ? widget.onAttach : null,
                    ),
                    GhostIconButton(
                      icon: LucideIcons.atSign,
                      tooltip: '@ 提及文件',
                      onPressed: widget.enabled ? widget.onMention : null,
                    ),
                    GhostIconButton(
                      icon: LucideIcons.terminal,
                      tooltip: '命令',
                      onPressed: widget.enabled ? () {} : null,
                    ),
                    const Spacer(),
                    _Chip(
                      icon: LucideIcons.cpu,
                      label: widget.model,
                      muted: true,
                    ),
                    const SizedBox(width: CodemSpace.sm),
                    if (widget.running)
                      SizedBox(
                        width: CodemSize.button,
                        height: CodemSize.button,
                        child: IconButton.filled(
                          onPressed: widget.onStop,
                          style: IconButton.styleFrom(
                            backgroundColor: palette.danger,
                            foregroundColor: Colors.white,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(CodemRadius.sm),
                            ),
                          ),
                          icon: const Icon(LucideIcons.square, size: 18),
                        ),
                      )
                    else
                      SizedBox(
                        width: CodemSize.button,
                        height: CodemSize.button,
                        child: IconButton.filled(
                          onPressed: _hasText && widget.enabled ? _send : null,
                          style: IconButton.styleFrom(
                            backgroundColor: _hasText ? palette.accent : palette.surfaceRaised,
                            foregroundColor: _hasText ? Colors.white : palette.textSecondary,
                            disabledBackgroundColor: palette.surfaceRaised,
                            disabledForegroundColor: palette.textSecondary,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(CodemRadius.sm),
                            ),
                          ),
                          icon: const Icon(LucideIcons.arrowUp, size: 20),
                        ),
                      ),
                  ],
                ),
              ],
            ),
          ),
          if (widget.statusLine != null)
            Padding(
              padding: const EdgeInsets.only(top: CodemSpace.sm),
              child: widget.statusLine!,
            ),
        ],
      ),
    );
  }
}

class _AttachmentChip extends StatelessWidget {
  const _AttachmentChip({required this.attachment, required this.onRemove});

  final PendingAttachment attachment;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final kb = (attachment.bytes / 1024).toStringAsFixed(0);
    return Container(
      height: 32,
      padding: const EdgeInsets.only(left: CodemSpace.sm),
      decoration: BoxDecoration(
        color: palette.surfaceRaised,
        borderRadius: BorderRadius.circular(CodemRadius.sm),
        border: Border.all(color: palette.hairline),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(LucideIcons.image, size: 13, color: palette.accent),
          const SizedBox(width: 5),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 150),
            child: Text(
              '${attachment.name} · ${kb}KB',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: kCodemSans,
                fontSize: 11,
                color: palette.textPrimary,
              ),
            ),
          ),
          SizedBox(
            width: 32,
            height: 32,
            child: IconButton(
              padding: EdgeInsets.zero,
              onPressed: onRemove,
              icon: Icon(LucideIcons.x, size: 13, color: palette.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.icon, required this.label, this.muted = false});

  final IconData icon;
  final String label;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: CodemSpace.sm, vertical: 4),
      decoration: BoxDecoration(
        color: palette.surfaceRaised,
        borderRadius: BorderRadius.circular(CodemRadius.sm),
        border: Border.all(color: palette.hairline),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 13, color: muted ? palette.textSecondary : palette.accent),
          const SizedBox(width: 5),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 110),
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: kCodemSans,
                fontSize: 11,
                height: 1.3,
                color: muted ? palette.textSecondary : palette.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
