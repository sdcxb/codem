import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

class HostRpcException implements Exception {
  const HostRpcException(this.message, {this.kind = 'INTERNAL', this.code = -1, this.retryable = false});

  final String message;
  final String kind;
  final int code;
  final bool retryable;

  bool get unauthorized => kind == 'UNAUTHORIZED' || code == 401 || code == 403;

  @override
  String toString() => message;
}

class HelloInfo {
  const HelloInfo({
    required this.hostId,
    required this.supported,
    required this.unsupported,
    this.serverVersion = '',
    this.authKind,
  });

  final String hostId;
  final List<String> supported;
  final List<String> unsupported;
  final String serverVersion;
  final String? authKind;

  bool supports(String method) => supported.contains(method);
}

/// 与 `@codem/protocol` 对齐的最小 Dart 客户端。
///
/// - 请求：POST /rpc，JSON-RPC 2.0
/// - 事件：GET /events?sessionId=...，SSE
/// - 凭据：远程用配对下发的 cookie；本机用 Bearer localAuthToken
class HostClient {
  HostClient({
    required this.baseUrl,
    this.cookie,
    this.bearerToken,
    http.Client? httpClient,
  })  : _http = httpClient ?? http.Client(),
        _base = baseUrl.replaceAll(RegExp(r'/+$'), '');

  final String baseUrl;
  final String? cookie;
  final String? bearerToken;
  final http.Client _http;
  final String _base;

  String? _lastCookie;
  int _rpcId = 0;

  String? get currentCookie => _lastCookie ?? cookie;

  Map<String, String> _headers({bool json = false}) {
    final headers = <String, String>{};
    if (json) headers['content-type'] = 'application/json';
    final bearer = bearerToken?.trim();
    if (bearer != null && bearer.isNotEmpty) headers['authorization'] = 'Bearer $bearer';
    final c = currentCookie;
    if (c != null && c.isNotEmpty) headers['cookie'] = c;
    return headers;
  }

  Future<dynamic> rpc(String method, [Map<String, dynamic>? params]) async {
    _rpcId += 1;
    final res = await _http
        .post(
          Uri.parse('$_base/rpc'),
          headers: _headers(json: true),
          body: jsonEncode({
            'jsonrpc': '2.0',
            'id': _rpcId,
            'method': method,
            'params': params ?? const <String, dynamic>{},
          }),
        )
        .timeout(const Duration(seconds: 20));
    _captureCookie(res);
    dynamic body;
    try {
      body = jsonDecode(res.body);
    } catch (_) {
      body = null;
    }
    if (body is! Map) {
      if (res.statusCode == 401 || res.statusCode == 403) {
        throw const HostRpcException('未授权：请重新配对', kind: 'UNAUTHORIZED', code: 401);
      }
      throw HostRpcException('Host 返回了非 JSON 响应 (${res.statusCode})', retryable: true);
    }
    final error = body['error'];
    if (error is Map) {
      final data = error['data'] is Map ? Map<String, dynamic>.from(error['data'] as Map) : const <String, dynamic>{};
      throw HostRpcException(
        (error['message'] ?? 'Host 请求失败').toString(),
        kind: (data['kind'] ?? (res.statusCode == 401 ? 'UNAUTHORIZED' : 'INTERNAL')).toString(),
        code: (error['code'] as num?)?.toInt() ?? res.statusCode,
        retryable: data['retryable'] == true,
      );
    }
    return body['result'];
  }

  void _captureCookie(http.Response res) {
    final raw = res.headers['set-cookie'];
    if (raw == null || raw.isEmpty) return;
    final first = raw.split(',').first.split(';').first.trim();
    if (first.contains('=')) _lastCookie = first;
  }

  Future<HelloInfo> hello({String deviceName = 'Codem Android'}) async {
    final result = await rpc('host.hello', {
      'protocolVersion': 1,
      'client': {'name': 'codem-mobile', 'version': '0.1.0', 'platform': 'android'},
      'deviceName': deviceName,
      'claim': true,
    });
    final map = result is Map ? Map<String, dynamic>.from(result) : <String, dynamic>{};
    final caps = map['capabilities'] is Map
        ? Map<String, dynamic>.from(map['capabilities'] as Map)
        : <String, dynamic>{};
    final auth = map['auth'] is Map ? Map<String, dynamic>.from(map['auth'] as Map) : null;
    return HelloInfo(
      hostId: (map['hostId'] ?? _base).toString(),
      supported: (caps['supported'] as List?)?.map((e) => e.toString()).toList() ?? const [],
      unsupported: (caps['unsupported'] as List?)?.map((e) => e.toString()).toList() ?? const [],
      serverVersion: (map['server'] is Map ? (map['server'] as Map)['version'] : '')?.toString() ?? '',
      authKind: auth?['kind']?.toString(),
    );
  }

  Future<List<SessionSummary>> listSessions({int limit = 50}) async {
    final result = await rpc('session.list', {'limit': limit});
    final items = result is Map && result['items'] is List ? result['items'] as List : const [];
    return items.whereType<Map>().map((e) => SessionSummary.fromJson(Map<String, dynamic>.from(e))).toList();
  }

  Future<List<ProjectSummary>> listProjects({int limit = 50}) async {
    final result = await rpc('project.list', {'limit': limit});
    final items = result is Map && result['items'] is List ? result['items'] as List : const [];
    return items.whereType<Map>().map((e) => ProjectSummary.fromJson(Map<String, dynamic>.from(e))).toList();
  }

  Future<SessionSummary> createSession({String? title, String? projectId}) async {
    final result = await rpc('session.create', {
      if (title != null && title.trim().isNotEmpty) 'title': title.trim(),
      if (projectId != null && projectId.isNotEmpty) 'projectId': projectId,
    });
    final map = result is Map ? Map<String, dynamic>.from(result) : <String, dynamic>{};
    final session = map['session'] is Map ? Map<String, dynamic>.from(map['session'] as Map) : map;
    return SessionSummary.fromJson(session);
  }

  Future<({SessionSummary session, List<ChatMessage> messages, int eventSeq})> getSession(String sessionId) async {
    final result = await rpc('session.get', {'sessionId': sessionId, 'limit': 200});
    final map = result is Map ? Map<String, dynamic>.from(result) : <String, dynamic>{};
    final session = map['session'] is Map
        ? SessionSummary.fromJson(Map<String, dynamic>.from(map['session'] as Map))
        : SessionSummary(id: sessionId, title: '会话');
    final messages = (map['messages'] as List?)
            ?.whereType<Map>()
            .map((e) => ChatMessage.fromJson(Map<String, dynamic>.from(e)))
            .toList() ??
        <ChatMessage>[];
    return (session: session, messages: messages, eventSeq: (map['eventSeq'] as num?)?.toInt() ?? 0);
  }

  Future<String> sendPrompt(String sessionId, String text, {List<String>? attachmentIds}) async {
    final requestId = '${DateTime.now().microsecondsSinceEpoch}-${_rpcId + 1}';
    final result = await rpc('prompt.send', {
      'sessionId': sessionId,
      'requestId': requestId,
      'text': text,
      if (attachmentIds != null && attachmentIds.isNotEmpty) 'attachmentIds': attachmentIds,
    });
    final map = result is Map ? Map<String, dynamic>.from(result) : const <String, dynamic>{};
    return (map['runId'] ?? '').toString();
  }

  Future<String> uploadAttachment({
    required String name,
    required String mimeType,
    required String base64,
  }) async {
    final result = await rpc('attachment.put', {
      'name': name,
      'mimeType': mimeType,
      'base64': base64,
    });
    final map = result is Map ? Map<String, dynamic>.from(result) : const <String, dynamic>{};
    return (map['attachmentId'] ?? '').toString();
  }

  Future<void> cancel(String runId) async {
    final requestId = '${DateTime.now().microsecondsSinceEpoch}-cancel';
    await rpc('run.cancel', {'runId': runId, 'requestId': requestId});
  }

  Future<void> respondApproval(String approvalId, bool allow, {String? note}) async {
    await rpc('approval.respond', {
      'approvalId': approvalId,
      'requestId': '${DateTime.now().microsecondsSinceEpoch}-approval',
      'decision': allow ? 'allow' : 'deny',
      if (note != null && note.isNotEmpty) 'note': note,
    });
  }

  Future<List<ApprovalRequest>> listApprovals(String sessionId) async {
    final result = await rpc('approval.list', {'sessionId': sessionId});
    final map = result is Map ? Map<String, dynamic>.from(result) : <String, dynamic>{};
    return (map['items'] as List?)
            ?.whereType<Map>()
            .map((e) => ApprovalRequest.fromJson(Map<String, dynamic>.from(e)))
            .toList() ??
        <ApprovalRequest>[];
  }

  Future<void> watch(String sessionId, {int? sinceSeq}) async {
    await rpc('session.watch', {
      'sessionId': sessionId,
      if (sinceSeq != null && sinceSeq > 0) 'sinceSeq': sinceSeq,
    });
  }

  Future<({List<TurnChanges> items, bool supported, String? reason})> sessionChanges(String sessionId) async {
    final result = await rpc('session.changes', {'sessionId': sessionId, 'limit': 20});
    final map = result is Map ? Map<String, dynamic>.from(result) : <String, dynamic>{};
    final items = (map['items'] as List?)
            ?.whereType<Map>()
            .map((e) => TurnChanges.fromJson(Map<String, dynamic>.from(e)))
            .toList() ??
        <TurnChanges>[];
    return (items: items, supported: map['supported'] != false, reason: map['reason'] as String?);
  }

  Future<ChangeDiff> sessionChangeDiff(String sessionId, String changeId, String path) async {
    final result = await rpc('session.change.diff', {
      'sessionId': sessionId,
      'changeId': changeId,
      'path': path,
    });
    final map = result is Map ? Map<String, dynamic>.from(result) : <String, dynamic>{};
    return ChangeDiff(
      path: map['path'] as String? ?? path,
      status: map['status'] as String? ?? '',
      patch: map['patch'] as String? ?? '',
      truncated: map['truncated'] == true,
      supported: map['supported'] != false,
    );
  }

  Future<List<WorkspaceEntry>> workspaceList([String path = '']) async {
    final result = await rpc('workspace.list', {if (path.isNotEmpty) 'path': path});
    final map = result is Map ? Map<String, dynamic>.from(result) : <String, dynamic>{};
    return (map['entries'] as List?)
            ?.whereType<Map>()
            .map((e) => WorkspaceEntry.fromJson(Map<String, dynamic>.from(e)))
            .toList() ??
        const [];
  }

  Future<WorkspaceFile> workspaceRead(String path) async {
    final result = await rpc('workspace.read', {'path': path, 'limit': 200});
    final map = result is Map ? Map<String, dynamic>.from(result) : <String, dynamic>{};
    return WorkspaceFile(
      path: map['path'] as String? ?? path,
      text: map['text'] as String? ?? '',
      size: (map['size'] as num?)?.toInt() ?? 0,
      truncated: map['truncated'] == true,
      encoding: map['encoding'] as String? ?? 'utf8',
    );
  }

  /// SSE 事件流；断线由上层重连。
  Stream<SessionEvent> events(String sessionId, {int? sinceSeq}) async* {
    final request = http.Request('GET', Uri.parse('$_base/events?sessionId=${Uri.encodeQueryComponent(sessionId)}'));
    request.headers.addAll(_headers());
    request.headers['accept'] = 'text/event-stream';
    if (sinceSeq != null && sinceSeq > 0) request.headers['last-event-id'] = '$sinceSeq';
    final response = await _http.send(request).timeout(const Duration(seconds: 20));
    if (response.statusCode == 401 || response.statusCode == 403) {
      throw const HostRpcException('事件流未授权：请重新配对', kind: 'UNAUTHORIZED', code: 401);
    }
    if (response.statusCode != 200) {
      throw HostRpcException('事件流连接失败 (${response.statusCode})', retryable: true);
    }
    final lines = response.stream.transform(utf8.decoder).transform(const LineSplitter());
    await for (final line in lines) {
      if (!line.startsWith('data:')) continue;
      final data = line.substring(5).trim();
      if (data.isEmpty) continue;
      try {
        final decoded = jsonDecode(data);
        if (decoded is Map) yield SessionEvent.fromJson(Map<String, dynamic>.from(decoded));
      } catch (_) {
        // 单条坏事件不杀整条流。
      }
    }
  }

  Future<({String deviceId, String cookie})> pairClaim(String code, {String deviceName = 'Codem Android'}) async {
    final request = http.Request('POST', Uri.parse('$_base/rpc'));
    request.headers.addAll(_headers(json: true));
    request.body = jsonEncode({
      'jsonrpc': '2.0',
      'id': ++_rpcId,
      'method': 'pair.claim',
      'params': {'code': code, 'deviceName': deviceName, 'platform': 'android'},
    });
    final streamed = await _http.send(request).timeout(const Duration(seconds: 20));
    final bodyText = await streamed.stream.bytesToString();
    final setCookie = streamed.headers['set-cookie'] ?? '';
    final cookie = setCookie.split(',').first.split(';').first.trim();
    final body = jsonDecode(bodyText);
    if (body is Map && body['error'] != null) {
      final err = body['error'] as Map;
      throw HostRpcException((err['message'] ?? '配对失败').toString(), kind: 'PAIR_FAILED');
    }
    final result = body is Map ? body['result'] : null;
    final deviceId = result is Map ? (result['deviceId'] ?? '').toString() : '';
    if (cookie.isEmpty) {
      throw const HostRpcException('配对成功但没有拿到设备凭据', kind: 'PAIR_FAILED');
    }
    _lastCookie = cookie;
    return (deviceId: deviceId, cookie: cookie);
  }

  void close() => _http.close();
}
