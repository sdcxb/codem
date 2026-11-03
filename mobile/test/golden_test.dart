import 'dart:io';

import 'package:codem_mobile/design/theme.dart';
import 'package:codem_mobile/features/chat/chat_page.dart';
import 'package:codem_mobile/features/sessions/sessions_page.dart';
import 'package:codem_mobile/state/app_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Future<ByteData> _fontBytes(String path) async {
  final bytes = await File(path).readAsBytes();
  return ByteData.sublistView(Uint8List.fromList(bytes));
}

Future<void> _loadFonts() async {
  final sans = FontLoader('CodemSans')
    ..addFont(_fontBytes('assets/fonts/AlimamaFangYuanTiVF.ttf'));
  await sans.load();
  final mono = FontLoader('CodemMono')
    ..addFont(_fontBytes('assets/fonts/JetBrainsMono-Regular.ttf'));
  await mono.load();
  await _loadLucide();
}

Future<void> _loadLucide() async {
  final local = Platform.environment['LOCALAPPDATA'];
  if (local == null) return;
  final cache = Directory('$local\\Pub\\Cache\\hosted\\pub.dev');
  if (!cache.existsSync()) return;
  for (final entry in cache.listSync().whereType<Directory>()) {
    final name = entry.path.split(Platform.pathSeparator).last;
    if (!name.startsWith('lucide_icons_flutter-')) continue;
    final font = File('${entry.path}\\assets\\lucide.ttf');
    if (!font.existsSync()) continue;
    final bytes = await font.readAsBytes();
    for (final family in ['Lucide', 'packages/lucide_icons_flutter/Lucide']) {
      final loader = FontLoader(family)..addFont(Future.value(ByteData.sublistView(bytes)));
      await loader.load();
    }
    return;
  }
}

void _sizeToPhone(WidgetTester tester) {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(_loadFonts);

  testWidgets('sessions screen (dark)', (tester) async {
    _sizeToPhone(tester);
    final state = CodemAppState.preview();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: CodemTheme.dark(),
        home: Scaffold(
          body: SessionsPage(state: state, onOpenSession: (_) {}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await expectLater(find.byType(SessionsPage), matchesGoldenFile('goldens/sessions_dark.png'));
  });

  testWidgets('chat screen (dark)', (tester) async {
    _sizeToPhone(tester);
    final state = CodemAppState.preview();
    final session = state.sessions.first;
    state.previewOpen(session);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: CodemTheme.dark(),
        home: ChatPage(state: state, session: session),
      ),
    );
    await tester.pumpAndSettle();
    await expectLater(find.byType(ChatPage), matchesGoldenFile('goldens/chat_dark.png'));
  });

  testWidgets('sessions screen (light)', (tester) async {
    _sizeToPhone(tester);
    final state = CodemAppState.preview();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: CodemTheme.light(),
        home: Scaffold(
          body: SessionsPage(state: state, onOpenSession: (_) {}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await expectLater(find.byType(SessionsPage), matchesGoldenFile('goldens/sessions_light.png'));
  });
}
