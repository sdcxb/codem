import 'dart:convert';
import 'dart:io';

import 'package:codem_mobile/data/host_store.dart';
import 'package:codem_mobile/data/models.dart';
import 'package:codem_mobile/design/theme.dart';
import 'package:codem_mobile/features/hosts/host_sheets.dart';
import 'package:codem_mobile/features/hosts/local_host_sheet.dart';
import 'package:codem_mobile/platform/local_host.dart';
import 'package:codem_mobile/state/app_state.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 本机 Host 的 Dart 侧判据。
///
/// 用 MethodChannel mock 模拟 Android 原生，用一个真正的 loopback HttpServer
/// 承接 `HostClient` 的 hello/session.list/project.list，跑完整链路：
/// `start` → 写入 `HostProfile(kind: local)` → `connect`（Bearer 令牌）。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late HttpServer server;
  late String serverUrl;
  late List<String> rpcMethods;
  late List<String> authorizations;

  Future<void> handleRpc(HttpRequest request) async {
    if (request.uri.path != '/rpc') {
      request.response.statusCode = HttpStatus.notFound;
      await request.response.close();
      return;
    }
    final body = await utf8.decoder.bind(request).join();
    final rpc = jsonDecode(body) as Map<String, dynamic>;
    final method = rpc['method'] as String;
    rpcMethods.add(method);
    authorizations.add(request.headers.value('authorization') ?? '');
    dynamic result;
    switch (method) {
      case 'host.hello':
        result = {
          'hostId': 'local-host',
          'server': {
            'name': 'codem-host',
            'version': 'test',
            'protocolVersion': 1,
          },
          'capabilities': {
            'supported': ['session.list', 'session.create', 'prompt.send'],
            'unsupported': <String>[],
          },
        };
        break;
      case 'session.list':
        result = {'items': <dynamic>[], 'hasMore': false};
        break;
      case 'project.list':
        result = {'items': <dynamic>[], 'hasMore': false};
        break;
      default:
        request.response.write(jsonEncode({
          'jsonrpc': '2.0',
          'id': rpc['id'],
          'error': {'code': -32601, 'message': 'not found'},
        }));
        await request.response.close();
        return;
    }
    request.response.headers.contentType = ContentType.json;
    request.response.write(jsonEncode({'jsonrpc': '2.0', 'id': rpc['id'], 'result': result}));
    await request.response.close();
  }

  void mockLocalHost(Future<Object?> Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(LocalHostBridge.channel, handler);
  }

  void clearLocalHost() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(LocalHostBridge.channel, null);
  }

  setUp(() async {
    // flutter_test 默认把所有 HttpClient 拦成 400；这里跑的是 127.0.0.1 的真实
    // loopback 服务，必须放行（否则连不上“手机上的 Host”）。
    HttpOverrides.global = null;
    SharedPreferences.setMockInitialValues(<String, Object>{});
    rpcMethods = <String>[];
    authorizations = <String>[];
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    serverUrl = 'http://127.0.0.1:${server.port}';
    server.listen(handleRpc);
  });

  tearDown(() async {
    clearLocalHost();
    await server.close(force: true);
  });

  test('start 成功后把 loopback url/token 落成本机 HostProfile 并连接', () async {
    final channelCalls = <String>[];
    mockLocalHost((call) async {
      switch (call.method) {
        case 'saveModel':
          channelCalls.add('saveModel');
          final args = call.arguments as Map;
          expect(args['apiKey'], 'sk-test-secret-001', reason: 'Key 只经 MethodChannel 传给原生');
          return true;
        case 'start':
          channelCalls.add('start');
          return <String, Object?>{
            'url': serverUrl,
            'token': 'token-abc',
            'workspace': '/storage/emulated/0/codem/workspace',
            'shared': true,
            'project': 'my-app',
          };
        case 'status':
          return <String, Object?>{'running': false};
        default:
          return true;
      }
    });

    final state = CodemAppState();
    addTearDown(state.dispose);
    final ok = await state.startLocalHost(
      baseUrl: 'https://api.example.test/v1',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test-secret-001',
    );

    expect(ok, isTrue);
    expect(channelCalls, ['saveModel', 'start'], reason: '启动前必须先保存模型配置');
    final local = state.hosts.singleWhere((h) => h.kind == HostKind.local);
    expect(local.baseUrl, serverUrl);
    expect(local.cookie, 'token-abc', reason: '本机 Host 的 cookie 字段存的是 Bearer 令牌');
    expect(state.connected, isTrue);
    expect(state.activeHost?.kind, HostKind.local);
    expect(state.localHostStatus.running, isTrue);
    expect(state.localHostStatus.shared, isTrue);
    expect(state.localHostNeedsStart, isFalse);
    expect(state.localHostNeedsPermission, isFalse);
    expect(rpcMethods, contains('host.hello'));
    expect(authorizations, contains('Bearer token-abc'), reason: '本机 Host 必须用 Bearer 令牌连接');

    // 持久化：重启后 HostStore 仍能读到 loopback 地址与令牌。
    final reloaded = await HostStore().load();
    final saved = reloaded.singleWhere((h) => h.kind == HostKind.local);
    expect(saved.baseUrl, serverUrl);
    expect(saved.cookie, 'token-abc');
  });

  test('saveModel / start 失败时错误不泄露 API Key', () async {
    const secret = 'sk-test-supersecret-123456';
    mockLocalHost((call) async {
      if (call.method == 'saveModel' || call.method == 'start') {
        throw PlatformException(
          code: 'save_failed',
          message: '保存失败：key $secret 被拒绝',
        );
      }
      return <String, Object?>{'running': false};
    });

    final state = CodemAppState();
    addTearDown(state.dispose);

    final saved = await state.saveLocalModel(
      baseUrl: 'https://api.example.test/v1',
      model: 'deepseek-v4-flash',
      apiKey: secret,
    );
    expect(saved, isFalse);
    expect(state.localHostError, isNotNull);
    expect(state.localHostError, isNot(contains(secret)));
    expect(state.localHostError, contains('***'), reason: 'Key 应被脱敏成 ***');
    expect(state.localModel.model, 'deepseek-v4-flash', reason: '失败也要记住服务地址/模型名，重开面板能回填');
    expect(state.localModel.hasKey, isFalse, reason: '保存失败不能谎称 Key 已保存');

    final started = await state.startLocalHost(
      baseUrl: 'https://api.example.test/v1',
      model: 'deepseek-v4-flash',
      apiKey: secret,
    );
    expect(started, isFalse);
    expect(state.localHostError, isNot(contains(secret)));
    expect(state.localHostStatus.running, isFalse);
    expect(state.hosts.where((h) => h.kind == HostKind.local), isEmpty,
        reason: '启动失败不能写入半成品 HostProfile');
  });

  test('App 启动时 status=running 自动连接本机 Host', () async {
    final store = HostStore();
    const stale = HostProfile(
      id: 'local-android',
      name: '本机 Host',
      baseUrl: 'http://127.0.0.1:1',
      kind: HostKind.local,
      online: false,
    );
    await store.save([stale]);
    await store.saveCookie(stale, 'stale-token');

    mockLocalHost((call) async {
      switch (call.method) {
        case 'status':
          return <String, Object?>{
            'running': true,
            'url': serverUrl,
            'token': 'fresh-token',
            'workspace': '/storage/emulated/0/codem/workspace',
            'shared': true,
            'project': 'my-app',
          };
        default:
          return true;
      }
    });

    final state = CodemAppState();
    addTearDown(state.dispose);
    await state.init();

    expect(state.booting, isFalse);
    expect(state.connected, isTrue);
    expect(state.localHostNeedsStart, isFalse);
    expect(state.localHostStatus.running, isTrue);
    expect(state.activeHost?.baseUrl, serverUrl,
        reason: '端口每次启动都会变，必须用 status 返回的 loopback 地址');
    expect(state.activeHost?.cookie, 'fresh-token');
    expect(authorizations, contains('Bearer fresh-token'));

    final persisted = (await HostStore().load()).singleWhere((h) => h.kind == HostKind.local);
    expect(persisted.baseUrl, serverUrl);
    expect(persisted.cookie, 'fresh-token');
  });

  test('App 启动时 status=stopped 不报错，只提示启动本机 Host', () async {
    final store = HostStore();
    const local = HostProfile(
      id: 'local-android',
      name: '本机 Host',
      baseUrl: 'http://127.0.0.1:41873',
      kind: HostKind.local,
      online: false,
    );
    await store.save([local]);

    mockLocalHost((call) async {
      switch (call.method) {
        case 'status':
          return <String, Object?>{'running': false};
        default:
          return true;
      }
    });

    final state = CodemAppState();
    addTearDown(state.dispose);
    await state.init();

    expect(state.connected, isFalse);
    expect(state.error, isNull, reason: '没启动不是连接失败');
    expect(state.demo, isFalse);
    expect(state.localHostNeedsStart, isTrue);
    expect(state.activeHost?.kind, HostKind.local);
    expect(state.hosts, hasLength(1));
  });

  test('停止本机 Host 后断开连接并保留配置', () async {
    var running = false;
    mockLocalHost((call) async {
      switch (call.method) {
        case 'saveModel':
          return true;
        case 'start':
          running = true;
          return <String, Object?>{
            'url': serverUrl,
            'token': 'token-stop',
            'workspace': '/storage/emulated/0/codem/workspace',
            'shared': true,
          };
        case 'stop':
          running = false;
          return true;
        case 'status':
          return <String, Object?>{'running': running};
        default:
          return true;
      }
    });

    final state = CodemAppState();
    addTearDown(state.dispose);
    expect(
      await state.startLocalHost(
        baseUrl: 'https://api.example.test/v1',
        model: 'deepseek-v4-flash',
        apiKey: 'sk-test-secret-002',
      ),
      isTrue,
    );
    expect(state.connected, isTrue);

    await state.stopLocalHost();

    expect(state.connected, isFalse);
    expect(state.localHostStatus.running, isFalse);
    expect(state.localHostNeedsStart, isTrue, reason: '停止后 UI 要能再次引导启动');
    expect(state.client, isNull);
    expect(state.activeHost?.kind, HostKind.local, reason: '配置保留，用户可再次启动');
    expect(state.hosts.where((h) => h.kind == HostKind.local), hasLength(1));
  });

  test('选择的项目会记住（Host 停止时 status 不带 project）', () async {
    mockLocalHost((call) async {
      switch (call.method) {
        case 'setProject':
          return true;
        case 'status':
          return <String, Object?>{'running': false};
        default:
          return true;
      }
    });

    final state = CodemAppState();
    addTearDown(state.dispose);
    expect(await state.setLocalProject('my-app'), isTrue);
    expect(state.localProject, 'my-app');
    expect(await HostStore().loadLocalProject(), 'my-app');

    // 模拟重启：新 state 从本地记忆 + 原生 status（未运行，无 project）回填。
    final store = HostStore();
    await store.save(const [
      HostProfile(
        id: 'local-android',
        name: '本机 Host',
        baseUrl: 'http://127.0.0.1:41873',
        kind: HostKind.local,
      ),
    ]);
    final restored = CodemAppState();
    addTearDown(restored.dispose);
    await restored.init();
    expect(restored.localProject, 'my-app');
    expect(restored.localHostNeedsStart, isTrue);
  });

  test('缺存储权限不算启动失败：可去授权、可回退私有工作区', () async {
    var startCalls = 0;
    var requestCalls = 0;
    Map<Object?, Object?>? lastStartArgs;
    mockLocalHost((call) async {
      switch (call.method) {
        case 'saveModel':
          return true;
        case 'start':
          startCalls += 1;
          lastStartArgs = call.arguments as Map<Object?, Object?>;
          if (lastStartArgs!['allowPrivateFallback'] == true) {
            return <String, Object?>{
              'url': serverUrl,
              'token': 'private-token',
              'workspace': '/data/user/0/com.codem.app/files/workspace',
              'shared': false,
            };
          }
          return <String, Object?>{
            'needsPermission': true,
            'permission': 'manage_external_storage',
            'workspace': '/storage/emulated/0/codem/workspace',
            'storage': <String, Object?>{'granted': false},
          };
        case 'requestStorageAccess':
          requestCalls += 1;
          return true;
        case 'status':
          return <String, Object?>{'running': false};
        default:
          return true;
      }
    });

    final state = CodemAppState();
    addTearDown(state.dispose);

    final first = await state.startLocalHost(
      baseUrl: 'https://api.example.test/v1',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test-secret-003',
    );
    expect(first, isFalse);
    expect(startCalls, 1);
    expect(state.localHostNeedsPermission, isTrue);
    expect(state.localHostError, contains('权限'));
    expect(state.connected, isFalse);
    expect(state.hosts.where((h) => h.kind == HostKind.local), isEmpty,
        reason: '权限没给时不写半成品 HostProfile');
    expect(state.localModel.hasKey, isTrue, reason: '配置要保留，用户可直接重试');
    expect(state.localModel.model, 'deepseek-v4-flash');

    // 「去授权」：调原生请求后由 UI 重试 start。
    expect(await state.requestLocalHostStorageAccess(), isTrue);
    expect(requestCalls, 1);
    expect(state.localHostNeedsPermission, isFalse);

    // 用户决定不回共享目录：带 allowPrivateFallback 重试（Key 沿用原生已保存的）。
    final fallback = await state.startLocalHost(
      baseUrl: 'https://api.example.test/v1',
      model: 'deepseek-v4-flash',
      allowPrivateFallback: true,
    );
    expect(fallback, isTrue);
    expect(startCalls, 2);
    expect(lastStartArgs!['allowPrivateFallback'], isTrue);
    expect(lastStartArgs!.containsKey('apiKey'), isFalse,
        reason: 'Key 留空时不传该字段，原生沿用已保存的 Key');
    expect(state.localHostStatus.shared, isFalse);
    expect(state.localWorkspace, contains('files/workspace'));
    expect(state.localHostNeedsPermission, isFalse);
    expect(state.connected, isTrue);
  });

  test('去授权：requestStorageAccess=false（只开了系统页）要复查后才重试', () async {
    var startCalls = 0;
    var storageChecks = 0;
    mockLocalHost((call) async {
      switch (call.method) {
        case 'saveModel':
          return true;
        case 'start':
          startCalls += 1;
          if (startCalls == 1) {
            return <String, Object?>{
              'needsPermission': true,
              'permission': 'manage_external_storage',
              'storage': <String, Object?>{'granted': false},
            };
          }
          return <String, Object?>{
            'url': serverUrl,
            'token': 'after-grant',
            'workspace': '/storage/emulated/0/codem/workspace',
            'shared': true,
          };
        case 'requestStorageAccess':
          return false; // 原生语义：只是打开了系统授权页
        case 'storageAccess':
          storageChecks += 1;
          return <String, Object?>{
            'granted': true,
            'permission': 'manage_external_storage',
            'shared': true,
            'workspace': '/storage/emulated/0/codem/workspace',
          };
        case 'status':
          return <String, Object?>{'running': false};
        default:
          return true;
      }
    });

    final state = CodemAppState();
    addTearDown(state.dispose);
    expect(
      await state.startLocalHost(
        baseUrl: 'https://api.example.test/v1',
        model: 'deepseek-v4-flash',
        apiKey: 'sk-test-secret-005',
      ),
      isFalse,
    );
    expect(state.localHostNeedsPermission, isTrue);

    expect(await state.requestLocalHostStorageAccess(), isFalse,
        reason: '打开系统授权页不代表已授权');
    expect(state.localHostNeedsPermission, isTrue);
    expect(state.localHostError, contains('系统授权页'));

    // 回到前台：复查 storageAccess 拿到权限。
    expect(await state.refreshLocalHostStorageAccess(), isTrue);
    expect(storageChecks, 1);
    expect(state.localHostNeedsPermission, isFalse);
    expect(state.localHostError, isNull);

    final retry = await state.startLocalHost(
      baseUrl: 'https://api.example.test/v1',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test-secret-005',
    );
    expect(retry, isTrue);
    expect(startCalls, 2);
    expect(state.connected, isTrue);
    expect(state.localHostStatus.token, 'after-grant');
  });

  test('没有原生实现时给出可读中文错误且不崩', () async {
    clearLocalHost();
    final state = CodemAppState();
    addTearDown(state.dispose);

    await state.refreshLocalHostStatus();
    expect(state.localHostAvailable, isFalse);
    expect(state.localHostError, isNull, reason: '非 Android 环境入口不展示，不制造错误');

    final ok = await state.startLocalHost(
      baseUrl: 'https://api.example.test/v1',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test-secret-004',
    );
    expect(ok, isFalse);
    expect(state.localHostError, contains('本机 Host'));
    expect(state.localHostError, isNot(contains('sk-test-secret-004')));
  });

  testWidgets('Android 上「添加主机」提供本机运行入口', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    try {
      mockLocalHost((call) async => <String, Object?>{'running': false});

      final state = CodemAppState();
      addTearDown(state.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: CodemTheme.dark(),
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showAddHostSheet(context, state),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('本机运行（Android）'), findsOneWidget);
      expect(find.text('远程电脑'), findsOneWidget);
      // 选「本机」后不再要求 URL / 配对码。
      await tester.tap(find.text('本机运行（Android）'));
      await tester.pumpAndSettle();
      expect(find.text('配置并启动本机 Host'), findsOneWidget);
      expect(find.text('配对码（可选，6 位数字）'), findsNothing);
    } finally {
      // flutter_test 会在测试体结束时校验 debug 变量，必须在本体内恢复。
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets('本机 Host 面板展示模型配置、项目下拉与启动按钮', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    try {
      mockLocalHost((call) async {
        switch (call.method) {
          case 'status':
            return <String, Object?>{'running': false};
          case 'modelConfig':
            return <String, Object?>{
              'baseUrl': 'https://api.example.test/v1',
              'model': 'deepseek-v4-flash',
              'hasKey': true,
            };
          case 'listProjects':
            return <String>['', 'my-app'];
          default:
            return true;
        }
      });

      final state = CodemAppState();
      addTearDown(state.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: CodemTheme.dark(),
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showLocalHostSheet(context, state),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('本机 Host'), findsOneWidget);
      expect(find.text('API Key'), findsOneWidget);
      expect(find.text('启动并连接'), findsOneWidget);
      expect(find.text('工作区根目录'), findsOneWidget);
      expect(find.textContaining('已保存，留空则沿用'), findsOneWidget);

      final apiKeyField = tester
          .widgetList<TextField>(find.byType(TextField))
          .firstWhere((field) => field.obscureText);
      expect(apiKeyField.obscureText, isTrue, reason: 'API Key 输入必须隐藏');

      final baseUrlField = tester
          .widgetList<TextField>(find.byType(TextField))
          .firstWhere((field) => field.controller?.text == 'https://api.example.test/v1');
      expect(baseUrlField.controller?.text, 'https://api.example.test/v1');
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  group('LocalHostConfig', () {
    test('validate 给出中文可操作提示', () {
      const empty = LocalHostConfig(baseUrl: '', model: '');
      expect(empty.validate(), contains('模型服务地址'));

      const badScheme = LocalHostConfig(baseUrl: 'api.example.test', model: 'm', apiKey: 'sk-1');
      expect(badScheme.validate(), contains('http'));

      const noModel = LocalHostConfig(baseUrl: 'https://x.test/v1', model: ' ', apiKey: 'sk-1');
      expect(noModel.validate(), contains('模型名'));

      const noKey = LocalHostConfig(baseUrl: 'https://x.test/v1', model: 'm');
      expect(noKey.validate(), contains('API Key'));
      expect(noKey.validate(requireApiKey: false), isNull);

      const ok = LocalHostConfig(baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'sk-1');
      expect(ok.validate(), isNull);
    });

    test('toString 不包含 Key 明文，toMap 可控是否带 Key', () {
      const config = LocalHostConfig(
        baseUrl: 'https://x.test/v1',
        model: 'm',
        apiKey: 'sk-very-secret-999',
      );
      expect(config.toString(), isNot(contains('sk-very-secret-999')));
      expect(config.toMap()['apiKey'], 'sk-very-secret-999');
      expect(config.toMap(includeApiKey: false).containsKey('apiKey'), isFalse);
    });
  });

  group('LocalHostStatus', () {
    test('start 返回没有 running 字段时按 url/token 推断', () {
      final status = LocalHostStatus.fromMap(<String, Object?>{
        'url': 'http://127.0.0.1:1234',
        'token': 'abc',
      });
      expect(status.running, isTrue);
      expect(status.connectable, isTrue);
      expect(status.shared, isNull, reason: '原生没返回 shared 时不要擅自断言共享/私有');
    });

    test('running=false 或没有 token 时不可连接', () {
      expect(LocalHostStatus.stopped.connectable, isFalse);
      expect(
        LocalHostStatus.fromMap(<String, Object?>{'running': false, 'url': 'http://127.0.0.1:1', 'token': 't'})
            .connectable,
        isFalse,
      );
      expect(
        LocalHostStatus.fromMap(<String, Object?>{'running': true, 'url': 'http://127.0.0.1:1'}).connectable,
        isFalse,
      );
    });

    test('shared=false 表示回退到 App 私有工作区', () {
      final status = LocalHostStatus.fromMap(<String, Object?>{
        'running': true,
        'url': 'http://127.0.0.1:1',
        'token': 't',
        'shared': false,
      });
      expect(status.shared, isFalse);
    });
  });

  group('LocalHostException', () {
    test('权限异常被识别为可授权，而不是启动失败', () {
      final error = LocalHostException.fromPlatformException(
        PlatformException(
          code: 'needsPermission',
          message: 'MANAGE_EXTERNAL_STORAGE required',
          details: <String, Object?>{'permission': 'manage_external_storage', 'canRequest': true},
        ),
      );
      expect(error.needsPermission, isTrue);
      expect(error.unsupported, isFalse);
      expect(error.canRequestStorage, isTrue);
      expect(permissionMessage('manage_external_storage'), contains('所有文件访问'));
      expect(permissionMessage('write_external_storage'), contains('存储'));
    });

    test('错误文本里的 Key 会被抹掉', () {
      const secret = 'sk-leak-abcdef-123456';
      final error = LocalHostException.fromPlatformException(
        PlatformException(code: 'start_failed', message: 'boom $secret'),
        secret: secret,
      );
      expect(error.message, isNot(contains(secret)));
      expect(error.message, contains('***'));
    });

    test('MissingPlugin 类错误会标记 unsupported', () {
      final error = LocalHostException.fromPlatformException(
        PlatformException(code: 'channel-error', message: 'no implementation'),
      );
      expect(error.unsupported, isTrue);
    });
  });
}
