import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../theme.dart';
import '../tokens.dart';

class CodemMark extends StatelessWidget {
  const CodemMark({super.key, this.size = 26});

  final double size;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [palette.accent, palette.accentPressed],
        ),
        borderRadius: BorderRadius.circular(size * 0.3),
      ),
      child: Center(
        child: Text(
          'C',
          style: TextStyle(
            fontFamily: kCodemSans,
            fontSize: size * 0.56,
            height: 1,
            fontWeight: FontWeight.w700,
            color: Colors.white,
          ),
        ),
      ),
    );
  }
}

class MonoText extends StatelessWidget {
  const MonoText(this.text, {super.key, this.color, this.size = 12, this.maxLines = 1});

  final String text;
  final Color? color;
  final double size;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      maxLines: maxLines,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        fontFamily: kCodemMono,
        fontFamilyFallback: const [kCodemSans],
        fontSize: size,
        height: 1.3,
        color: color ?? context.palette.textSecondary,
      ),
    );
  }
}

class CodemTopBar extends StatelessWidget implements PreferredSizeWidget {
  const CodemTopBar({
    super.key,
    this.title,
    this.leading,
    this.actions = const [],
    this.subtitle,
  });

  final Widget? title;
  final Widget? leading;
  final List<Widget> actions;
  final Widget? subtitle;

  @override
  Size get preferredSize => const Size.fromHeight(56);

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return AppBar(
      toolbarHeight: 56,
      leadingWidth: leading == null ? 0 : 56,
      leading: leading,
      titleSpacing: leading == null ? 20 : 0,
      title: title == null
          ? null
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                title!,
                ?subtitle,
              ],
            ),
      actions: [
        ...actions,
        const SizedBox(width: CodemSpace.sm),
      ],
      shape: Border(bottom: BorderSide(color: palette.hairline)),
    );
  }
}

class HostPill extends StatelessWidget {
  const HostPill({
    super.key,
    required this.name,
    required this.online,
    this.onTap,
  });

  final String name;
  final bool online;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(CodemRadius.sm),
        child: Container(
          constraints: const BoxConstraints(minHeight: CodemSize.touch),
          padding: const EdgeInsets.symmetric(horizontal: CodemSpace.sm),
          decoration: BoxDecoration(
            color: palette.surface,
            borderRadius: BorderRadius.circular(CodemRadius.sm),
            border: Border.all(color: palette.hairline),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: online ? palette.success : palette.textSecondary,
                ),
              ),
              const SizedBox(width: CodemSpace.sm),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 110),
                child: Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.texts.labelMedium?.copyWith(color: palette.textPrimary),
                ),
              ),
              const SizedBox(width: CodemSpace.xs),
              Icon(LucideIcons.chevronDown, size: 14, color: palette.textSecondary),
            ],
          ),
        ),
      ),
    );
  }
}

class SessionRow extends StatelessWidget {
  const SessionRow({
    super.key,
    required this.title,
    required this.subtitle,
    required this.time,
    required this.active,
    required this.onTap,
    this.running = false,
  });

  final String title;
  final String subtitle;
  final String time;
  final bool active;
  final bool running;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Material(
      color: active ? palette.accent.withValues(alpha: 0.08) : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: SizedBox(
          height: CodemSize.row,
          child: Row(
            children: [
              Container(
                width: 2,
                height: 32,
                decoration: BoxDecoration(
                  color: active ? palette.accent : Colors.transparent,
                  borderRadius: BorderRadius.circular(1),
                ),
              ),
              const SizedBox(width: CodemSpace.md),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: context.texts.titleMedium?.copyWith(
                              fontSize: 16,
                              fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                              color: palette.textPrimary,
                            ),
                          ),
                        ),
                        if (running) ...[
                          const SizedBox(width: CodemSpace.sm),
                          Container(
                            width: 6,
                            height: 6,
                            decoration: BoxDecoration(color: palette.accent, shape: BoxShape.circle),
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 3),
                    MonoText(subtitle, maxLines: 1),
                  ],
                ),
              ),
              const SizedBox(width: CodemSpace.sm),
              MonoText(time, size: 11),
              const SizedBox(width: CodemSpace.lg),
            ],
          ),
        ),
      ),
    );
  }
}

class SectionCard extends StatelessWidget {
  const SectionCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(CodemSpace.lg),
    this.onTap,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final content = Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(CodemRadius.md),
        border: Border.all(color: palette.hairline),
      ),
      child: child,
    );
    if (onTap == null) return content;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(CodemRadius.md),
        onTap: onTap,
        child: content,
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.body,
    this.action,
  });

  final IconData icon;
  final String title;
  final String body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: CodemSpace.xl, vertical: 48),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 56,
            height: 56,
            decoration: BoxDecoration(
              color: palette.accent.withValues(alpha: 0.10),
              shape: BoxShape.circle,
            ),
            child: Icon(icon, color: palette.accent, size: 24),
          ),
          const SizedBox(height: CodemSpace.lg),
          Text(title, style: context.texts.titleMedium, textAlign: TextAlign.center),
          const SizedBox(height: CodemSpace.sm),
          Text(
            body,
            textAlign: TextAlign.center,
            style: context.texts.bodySmall?.copyWith(color: palette.textSecondary),
          ),
          if (action != null) ...[
            const SizedBox(height: CodemSpace.xl),
            action!,
          ],
        ],
      ),
    );
  }
}

class PrimaryButton extends StatelessWidget {
  const PrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.expanded = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool expanded;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final button = FilledButton.icon(
      onPressed: onPressed,
      style: FilledButton.styleFrom(
        minimumSize: const Size(0, CodemSize.button),
        backgroundColor: palette.accent,
        foregroundColor: Colors.white,
        disabledBackgroundColor: palette.surfaceRaised,
        disabledForegroundColor: palette.textSecondary,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CodemRadius.sm)),
        padding: const EdgeInsets.symmetric(horizontal: CodemSpace.lg),
      ),
      icon: icon == null ? const SizedBox.shrink() : Icon(icon, size: 18),
      label: Text(label),
    );
    return expanded ? SizedBox(width: double.infinity, child: button) : button;
  }
}

class GhostIconButton extends StatelessWidget {
  const GhostIconButton({
    super.key,
    required this.icon,
    required this.onPressed,
    this.tooltip,
    this.color,
  });

  final IconData icon;
  final VoidCallback? onPressed;
  final String? tooltip;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return IconButton(
      onPressed: onPressed,
      tooltip: tooltip,
      icon: Icon(icon, size: CodemSize.iconLarge, color: color ?? palette.textSecondary),
      constraints: const BoxConstraints(minWidth: CodemSize.touch, minHeight: CodemSize.touch),
    );
  }
}
