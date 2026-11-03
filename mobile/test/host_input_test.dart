import 'package:codem_mobile/features/hosts/host_sheets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parses pair link and extracts code', () {
    final parsed = parseHostInput('https://pc.tail.ts.net/pair?code=123456');
    expect(parsed.baseUrl, 'https://pc.tail.ts.net');
    expect(parsed.code, '123456');
  });

  test('parses codem deep link', () {
    final parsed = parseHostInput(
      'codem://pair?host=${Uri.encodeComponent('https://pc.tail.ts.net')}&code=654321',
    );
    expect(parsed.baseUrl, 'https://pc.tail.ts.net');
    expect(parsed.code, '654321');
  });

  test('adds https to bare hostname', () {
    final parsed = parseHostInput('pc.tail.ts.net');
    expect(parsed.baseUrl, 'https://pc.tail.ts.net');
    expect(parsed.code, isNull);
  });
}
