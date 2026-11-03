import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../design/theme.dart';
import '../../data/models.dart';
import '../../state/app_state.dart';
import '../chat/chat_page.dart';
import '../projects/projects_page.dart';
import '../sessions/sessions_page.dart';
import '../settings/settings_page.dart';

class RootShell extends StatefulWidget {
  const RootShell({super.key, required this.state});

  final CodemAppState state;

  @override
  State<RootShell> createState() => _RootShellState();
}

class _RootShellState extends State<RootShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      SessionsPage(state: widget.state, onOpenSession: _open),
      ProjectsPage(state: widget.state),
      SettingsPage(state: widget.state),
    ];
    return Scaffold(
      resizeToAvoidBottomInset: false,
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: CodemNavBar(
        index: _index,
        onChanged: (value) => setState(() => _index = value),
      ),
    );
  }

  void _open(SessionSummary session) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ChatPage(state: widget.state, session: session),
      ),
    );
  }
}

class CodemNavBar extends StatelessWidget {
  const CodemNavBar({super.key, required this.index, required this.onChanged});

  final int index;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final items = const [
      (LucideIcons.messageSquare, '会话'),
      (LucideIcons.folder, '项目'),
      (LucideIcons.settings, '设置'),
    ];
    return Container(
      decoration: BoxDecoration(
        color: palette.canvas,
        border: Border(top: BorderSide(color: palette.hairline)),
      ),
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: 58,
          child: Row(
            children: [
              for (var i = 0; i < items.length; i++)
                Expanded(
                  child: InkWell(
                    onTap: () => onChanged(i),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          items[i].$1,
                          size: 20,
                          color: i == index ? palette.accent : palette.textSecondary,
                        ),
                        const SizedBox(height: 3),
                        Text(
                          items[i].$2,
                          style: TextStyle(
                            fontFamily: kCodemSans,
                            fontSize: 11,
                            height: 1.2,
                            fontWeight: i == index ? FontWeight.w600 : FontWeight.w400,
                            color: i == index ? palette.accent : palette.textSecondary,
                          ),
                        ),
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
}
