import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../data/models.dart';
import '../../design/components/common.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../../state/app_state.dart';

Future<void> showWorkspaceSheet(BuildContext context, CodemAppState state) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _WorkspaceSheet(state: state),
  );
}

class _WorkspaceSheet extends StatefulWidget {
  const _WorkspaceSheet({required this.state});

  final CodemAppState state;

  @override
  State<_WorkspaceSheet> createState() => _WorkspaceSheetState();
}

class _WorkspaceSheetState extends State<_WorkspaceSheet> {
  final List<String> _stack = [];
  List<WorkspaceEntry> _entries = const [];
  bool _loading = true;
  String? _error;

  String get _path => _stack.join('/');

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final entries = await widget.state.listWorkspace(_path);
      if (!mounted) return;
      setState(() {
        _entries = entries;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      height: MediaQuery.sizeOf(context).height * 0.78,
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(CodemRadius.sheet)),
        border: Border(top: BorderSide(color: palette.hairline)),
      ),
      child: Column(
        children: [
          const SizedBox(height: CodemSpace.sm),
          Container(
            width: 34,
            height: 4,
            decoration: BoxDecoration(color: palette.hairline, borderRadius: BorderRadius.circular(2)),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(CodemSpace.lg, CodemSpace.md, CodemSpace.sm, CodemSpace.sm),
            child: Row(
              children: [
                if (_stack.isNotEmpty)
                  GhostIconButton(
                    icon: LucideIcons.chevronLeft,
                    tooltip: '上一级',
                    onPressed: () {
                      setState(() => _stack.removeLast());
                      _load();
                    },
                  )
                else
                  const SizedBox(width: CodemSpace.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('文件', style: context.texts.titleMedium),
                      MonoText(_path.isEmpty ? '项目根目录' : '/$_path', size: 11),
                    ],
                  ),
                ),
                GhostIconButton(icon: LucideIcons.refreshCw, tooltip: '刷新', onPressed: _load),
              ],
            ),
          ),
          Divider(color: palette.hairline, height: 1),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : _error != null
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(CodemSpace.xl),
                          child: Text(_error!, style: context.texts.bodySmall, textAlign: TextAlign.center),
                        ),
                      )
                    : _entries.isEmpty
                        ? Center(child: Text('空目录', style: context.texts.bodySmall))
                        : ListView.separated(
                            itemCount: _entries.length,
                            separatorBuilder: (_, _) => Divider(
                              height: 1,
                              indent: 52,
                              color: palette.hairline,
                            ),
                            itemBuilder: (context, index) {
                              final entry = _entries[index];
                              return InkWell(
                                onTap: () => entry.isDir ? _enter(entry.name) : _open(entry),
                                child: SizedBox(
                                  height: 56,
                                  child: Row(
                                    children: [
                                      const SizedBox(width: CodemSpace.lg),
                                      Icon(
                                        entry.isDir ? LucideIcons.folder : LucideIcons.fileText,
                                        size: 18,
                                        color: entry.isDir ? palette.accent : palette.textSecondary,
                                      ),
                                      const SizedBox(width: CodemSpace.md),
                                      Expanded(child: Text(entry.name, style: context.texts.bodyLarge)),
                                      if (!entry.isDir)
                                        MonoText('${(entry.size / 1024).toStringAsFixed(0)}KB', size: 10),
                                      const SizedBox(width: CodemSpace.lg),
                                    ],
                                  ),
                                ),
                              );
                            },
                          ),
          ),
        ],
      ),
    );
  }

  void _enter(String name) {
    setState(() => _stack.add(name));
    _load();
  }

  Future<void> _open(WorkspaceEntry entry) async {
    final path = [..._stack, entry.name].join('/');
    try {
      final file = await widget.state.readWorkspace(path);
      if (!mounted) return;
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        backgroundColor: context.palette.surface,
        builder: (context) => DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.75,
          maxChildSize: 0.95,
          builder: (context, controller) => Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(CodemSpace.lg),
                child: Row(
                  children: [
                    Expanded(child: MonoText(file.path, color: context.palette.textPrimary)),
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
                    file.encoding == 'binary' ? '二进制文件，暂不支持预览。' : file.text,
                    style: TextStyle(
                      fontFamily: kCodemMono,
                      fontSize: 12,
                      height: 1.5,
                      color: context.palette.textPrimary,
                    ),
                  ),
                ),
              ),
              if (file.truncated)
                Padding(
                  padding: const EdgeInsets.only(bottom: CodemSpace.md),
                  child: Text('文件已截断', style: context.texts.labelSmall),
                ),
            ],
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('读取失败：$e')));
    }
  }
}
