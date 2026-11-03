import 'dart:convert';
import 'dart:io';

import 'package:codem_mobile/data/host_client.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late HttpServer server;
  late int port;
  final calls = <String>[];

  setUp(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    port = server.port;
    server.listen((request) async {
      if (request.uri.path == '/events') {
        request.response.headers.contentType = ContentType('text', 'event-stream', charset: 'utf-8');
        request.response.add(utf8.encode('data: ${jsonEncode({
          'seq': 1,
          'sessionId': 's1',
          'type': 'assistant.text',
          'payload': {'text': '你好'},
        })}\n\n'));
        request.response.add(utf8.encode('data: ${jsonEncode({
          'seq': 2,
          'sessionId': 's1',
          'type': 'run.finished',
          'payload': {},
        })}\n\n'));
        await request.response.close();
        return;
      }
      final body = await utf8.decoder.bind(request).join();
      final rpc = jsonDecode(body) as Map<String, dynamic>;
      final method = rpc['method'] as String;
      calls.add(method);
      final id = rpc['id'];
      dynamic result;
      if (method == 'host.hello') {
        request.response.headers.add(
          'set-cookie',
          'codem_gateway_device=zero-code-token; Path=/; HttpOnly; SameSite=Strict',
        );
      }
      switch (method) {
        case 'host.hello':
          result = {
            'hostId': 'host-test',
            'server': {'name': 'codem-host', 'version': 'test', 'protocolVersion': 1},
            'capabilities': {
              'supported': ['session.list', 'session.get', 'prompt.send', 'run.cancel', 'approval.respond'],
              'unsupported': <String>[],
            },
            'lease': {'holder': 'local'},
          };
          break;
        case 'session.list':
          result = {
            'items': [
              {
                'id': 's1',
                'projectId': 'p1',
                'title': '测试会话',
                'createdAt': 1,
                'lastMessageAt': 2,
                'messageCount': 3,
              }
            ],
            'hasMore': false,
          };
          break;
        case 'session.get':
          result = {
            'session': {
              'id': 's1',
              'projectId': 'p1',
              'title': '测试会话',
              'createdAt': 1,
              'lastMessageAt': 2,
              'messageCount': 1,
            },
            'messages': [
              {
                'id': 'm1',
                'role': 'assistant',
                'content': 'hello',
                'timestamp': 2,
              }
            ],
            'hasMore': false,
            'eventSeq': 0,
          };
          break;
        case 'prompt.send':
          result = {'accepted': true, 'runId': 'run-1', 'eventSeq': 0};
          break;
        case 'session.watch':
          result = {'subscriptionId': 'sub-1', 'fromSeq': 0, 'truncated': false};
          break;
        case 'run.cancel':
          result = {'runId': 'run-1', 'cancelled': true};
          break;
        case 'approval.respond':
          result = {'ok': true};
          break;
        default:
          request.response.statusCode = 200;
          request.response.write(jsonEncode({
            'jsonrpc': '2.0',
            'id': id,
            'error': {'code': -32601, 'message': 'not found'},
          }));
          await request.response.close();
          return;
      }
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode({'jsonrpc': '2.0', 'id': id, 'result': result}));
      await request.response.close();
    });
  });

  tearDown(() async {
    await server.close(force: true);
  });

  test('handshake, list sessions, get session, send prompt', () async {
    final client = HostClient(baseUrl: 'http://127.0.0.1:$port');
    final hello = await client.hello();
    expect(hello.hostId, 'host-test');
    expect(hello.supports('prompt.send'), isTrue);
    expect(
      client.currentCookie,
      'codem_gateway_device=zero-code-token',
      reason: '零配对码的 Set-Cookie 必须被客户端接住，后续 /events 才能鉴权',
    );
    final sessions = await client.listSessions();
    expect(sessions.single.title, '测试会话');
    final got = await client.getSession('s1');
    expect(got.messages.single.content, 'hello');
    final runId = await client.sendPrompt('s1', '继续');
    expect(runId, 'run-1');
    expect(calls, containsAll(['host.hello', 'session.list', 'session.get', 'prompt.send']));
    client.close();
  });

  test('SSE events decode and preserve seq', () async {
    final client = HostClient(baseUrl: 'http://127.0.0.1:$port');
    final events = await client.events('s1').toList();
    expect(events.length, 2);
    expect(events.first.type, 'assistant.text');
    expect(events.first.textDelta, '你好');
    expect(events.last.seq, 2);
    client.close();
  });
}
