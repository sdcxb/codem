import 'package:flutter/material.dart';

import '../../data/models.dart';
import '../theme.dart';
import '../tokens.dart';
import 'common.dart';

class ApprovalCard extends StatelessWidget {
  const ApprovalCard({
    super.key,
    required this.request,
    required this.onAllow,
    required this.onDeny,
    this.busy = false,
  });

  final ApprovalRequest request;
  final VoidCallback onAllow;
  final VoidCallback onDeny;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final detail = request.details?['command'] ?? request.details?['path'] ?? request.details?['diff'];
    return Container(
      margin: const EdgeInsets.fromLTRB(CodemSpace.lg, CodemSpace.sm, CodemSpace.lg, 0),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(CodemRadius.md),
        border: Border.all(color: palette.warning.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(CodemSpace.lg, CodemSpace.md, CodemSpace.lg, CodemSpace.sm),
            child: Row(
              children: [
                Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(color: palette.warning, shape: BoxShape.circle),
                ),
                const SizedBox(width: CodemSpace.sm),
                Expanded(
                  child: Text(
                    request.summary,
                    style: context.texts.labelLarge?.copyWith(fontSize: 14),
                  ),
                ),
                MonoText(request.tool, size: 11),
              ],
            ),
          ),
          if (detail != null)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.symmetric(horizontal: CodemSpace.lg),
              padding: const EdgeInsets.all(CodemSpace.md),
              decoration: BoxDecoration(
                color: palette.codeBg,
                borderRadius: BorderRadius.circular(CodemRadius.sm),
                border: Border.all(color: palette.hairline),
              ),
              child: Text(
                detail.toString(),
                maxLines: 5,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontFamily: kCodemMono,
                  fontSize: 12,
                  height: 1.5,
                  color: palette.textPrimary,
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.all(CodemSpace.md),
            child: Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: busy ? null : onDeny,
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, CodemSize.button),
                      foregroundColor: palette.danger,
                      side: BorderSide(color: palette.danger.withValues(alpha: 0.45)),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CodemRadius.sm)),
                    ),
                    child: const Text('拒绝'),
                  ),
                ),
                const SizedBox(width: CodemSpace.md),
                Expanded(
                  child: FilledButton(
                    onPressed: busy ? null : onAllow,
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(0, CodemSize.button),
                      backgroundColor: palette.accent,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CodemRadius.sm)),
                    ),
                    child: const Text('允许'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class StatusLine extends StatelessWidget {
  const StatusLine({
    super.key,
    required this.online,
    required this.label,
    this.suffix,
  });

  final bool online;
  final String label;
  final Widget? suffix;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Row(
      children: [
        Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: online ? palette.success : palette.textSecondary,
          ),
        ),
        const SizedBox(width: 6),
        Text(
          label,
          style: context.texts.labelSmall?.copyWith(fontSize: 11, color: palette.textSecondary),
        ),
        if (suffix != null) ...[
          const Spacer(),
          suffix!,
        ],
      ],
    );
  }
}
