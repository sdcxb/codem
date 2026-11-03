import 'package:flutter/material.dart';

import 'design/theme.dart';
import 'features/shell/root_shell.dart';
import 'state/app_state.dart';

class CodemApp extends StatefulWidget {
  const CodemApp({super.key, required this.state});

  final CodemAppState state;

  @override
  State<CodemApp> createState() => _CodemAppState();
}

class _CodemAppState extends State<CodemApp> {
  @override
  void initState() {
    super.initState();
    widget.state.init();
  }

  @override
  void dispose() {
    widget.state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.state,
      builder: (context, _) {
        return MaterialApp(
          title: 'Codem',
          debugShowCheckedModeBanner: false,
          theme: CodemTheme.light(),
          darkTheme: CodemTheme.dark(),
          themeMode: widget.state.themeMode,
          themeAnimationDuration: const Duration(milliseconds: 220),
          home: RootShell(state: widget.state),
        );
      },
    );
  }
}
