import 'package:codem_mobile/design/theme.dart';
import 'package:codem_mobile/design/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('Codem dark theme exposes brand tokens', (tester) async {
    late CodemPalette palette;
    await tester.pumpWidget(
      MaterialApp(
        theme: CodemTheme.dark(),
        home: Builder(
          builder: (context) {
            palette = context.palette;
            return const Scaffold(body: SizedBox());
          },
        ),
      ),
    );
    expect(palette.canvas, const Color(0xFF0F1217));
    expect(palette.accent, const Color(0xFF7C6CF0));
    expect(palette.textPrimary, const Color(0xFFE8E8EC));
  });

  testWidgets('light theme keeps paper canvas and violet accent', (tester) async {
    late CodemPalette palette;
    await tester.pumpWidget(
      MaterialApp(
        theme: CodemTheme.light(),
        home: Builder(
          builder: (context) {
            palette = context.palette;
            return const Scaffold(body: SizedBox());
          },
        ),
      ),
    );
    expect(palette.canvas, const Color(0xFFFAFAF9));
    expect(palette.accent, const Color(0xFF6555E0));
  });
}
