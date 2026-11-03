import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../data/host_client.dart';
import '../data/host_store.dart';
import '../data/models.dart';
import '../platform/native_bridge.dart';

/// 应用状态：主机、会话、消息、运行/审批。
///
/// N0 先内置 demo 数据，保证没有 Host 也能在真机审 UI；
/// 连接真实 Host 后 demo 自动退场。
class CodemAppState extends ChangeNotifier {
  CodemAppState({HostStore? store}) : _store = store ?? HostStore();

  /// 仅用于 widget/golden 测试与设计评审：不读插件、不发网络。
  factory CodemAppState.preview() {
    final state = CodemAppState();
    state._seedDemo();
    state.booting = false;
    return state;
  }

  final HostStore _store;

  List<HostProfile> hosts = [];
  HostProfile? activeHost;
  List<SessionSummary> sessions = [];
  List<ProjectSummary> projects = [];
  SessionSummary? currentSession;
  List<ChatMessage> messages = [];
  ApprovalRequest? approval;
  List<TurnChanges> changes = [];
  bool changesSupported = true;
  String? changesReason;
  bool changesLoading = false;
  List<PendingAttachment> attachments = [];

  bool booting = true;
  bool connecting = false;
  bool connected = false;
  bool running = false;
  bool demo = false;
  bool attachmentsSupported = false;
  String? error;
  String? runId;
  String? projectFilter;

  ThemeMode themeMode = ThemeMode.dark;
  bool keepAwake = true;

  HostClient? _client;
  StreamSubscription<SessionEvent>? _events;
  bool _disposed = false;
  int _eventSeq = 0;

  HostClient? get client => _client;

  Future<void> init() async {
    try {
      hosts = await _store.load();
      if (hosts.isEmpty) {
        const seed = String.fromEnvironment('CODEM_MOCK_HOST');
        if (seed.isNotEmpty) {
          hosts = [
            HostProfile(
              id: 'mock-host',
              name: 'Mock PC',
              baseUrl: seed,
              kind: HostKind.remote,
            ),
          ];
          await _store.save(hosts);
        }
      }
      if (hosts.isNotEmpty) {
        await connect(hosts.first, silent: true);
      } else {
        _seedDemo();
      }
    } catch (e) {
      _seedDemo();
      error = '加载本地主机失败：$e';
    } finally {
      booting = false;
      _notify();
    }
  }

  void setTheme(ThemeMode mode) {
    themeMode = mode;
    _notify();
  }

  Future<void> setKeepAwake(bool value) async {
    keepAwake = value;
    if (value) {
      await NativeBridge.startForeground(activeHost?.name ?? 'Codem');
    } else {
      await NativeBridge.stopForeground();
    }
    _notify();
  }

  Future<void> addHost({
    required String name,
    required String baseUrl,
    required HostKind kind,
    String? pairCode,
  }) async {
    final normalized = baseUrl.trim().replaceAll(RegExp(r'/+$'), '');
    if (normalized.isEmpty) {
      error = '地址不能为空';
      _notify();
      return;
    }
    final uri = Uri.tryParse(normalized);
    if (uri == null || !(uri.isScheme('http') || uri.isScheme('https'))) {
      error = '地址必须以 http:// 或 https:// 开头';
      _notify();
      return;
    }
    final id = 'host-${DateTime.now().microsecondsSinceEpoch}';
    var host = HostProfile(
      id: id,
      name: name.trim().isEmpty ? (kind == HostKind.local ? '本机' : '我的电脑') : name.trim(),
      baseUrl: normalized,
      kind: kind,
    );
    if (pairCode != null && pairCode.trim().isNotEmpty) {
      try {
        final client = HostClient(baseUrl: normalized);
        final claim = await client.pairClaim(pairCode.trim());
        client.close();
        host = host.copyWith(cookie: claim.cookie);
      } catch (e) {
        error = '配对失败：$e';
        _notify();
        return;
      }
    }
    hosts = [...hosts.where((h) => h.baseUrl != normalized), host];
    await _store.save(hosts);
    if (host.cookie != null) await _store.saveCookie(host, host.cookie!);
    await connect(host);
  }

  Future<void> connect(HostProfile host, {bool silent = false}) async {
    connecting = true;
    error = null;
    demo = false;
    connected = false;
    attachmentsSupported = false;
    _notify();
    await _events?.cancel();
    _events = null;
    _client?.close();
    _client = HostClient(
      baseUrl: host.baseUrl,
      cookie: host.cookie,
      bearerToken: host.kind == HostKind.local ? host.cookie : null,
    );
    try {
      final hello = await _client!.hello();
      attachmentsSupported = hello.supports('attachment.put');
      final list = await _client!.listSessions(limit: 60);
      sessions = list;
      try {
        projects = await _client!.listProjects(limit: 50);
      } catch (_) {
        projects = const [];
      }
      // 零配对码由 hello 现场发 cookie；把它落到这台 Host 上，下一次启动可直接复用。
      final freshCookie = _client!.currentCookie;
      final connectedHost = freshCookie == null ? host : host.copyWith(cookie: freshCookie);
      activeHost = connectedHost;
      connected = true;
      currentSession = null;
      messages = [];
      approval = null;
      hosts = hosts
          .map(
            (h) => h.id == host.id
                ? h.copyWith(
                    online: true,
                    lastSeenAt: DateTime.now().millisecondsSinceEpoch,
                    cookie: freshCookie,
                  )
                : h,
          )
          .toList();
      await _store.save(hosts);
      if (freshCookie != null) await _store.saveCookie(connectedHost, freshCookie);
      if (keepAwake) await NativeBridge.startForeground(host.name);
    } catch (e) {
      connected = false;
      activeHost = host;
      error = _messageFor(e);
      await NativeBridge.stopForeground();
      if (!silent) {
        // 保留 host，用户可重试/删除。
      }
    } finally {
      connecting = false;
      _notify();
    }
  }

  Future<void> retry() async {
    final host = activeHost;
    if (host == null) return;
    await connect(host);
  }

  Future<void> removeHost(HostProfile host) async {
    hosts = hosts.where((h) => h.id != host.id).toList();
    await _store.remove(host);
    await _store.save(hosts);
    if (activeHost?.id == host.id) {
      await _events?.cancel();
      _events = null;
      _client?.close();
      _client = null;
      connected = false;
      activeHost = null;
      await NativeBridge.stopForeground();
      if (hosts.isEmpty) _seedDemo();
    }
    _notify();
  }

  /// 设计评审/测试：直接打开一个 demo 会话（不触发网络）。
  void previewOpen(SessionSummary session) {
    currentSession = session;
    messages = _demoMessages(session);
    approval = null;
    _notify();
  }

  Future<SessionSummary> createSession({String? title, String? projectId}) async {
    if (demo || _client == null) {
      final session = SessionSummary(
        id: 'demo-new-${DateTime.now().microsecondsSinceEpoch}',
        title: title?.trim().isNotEmpty == true ? title!.trim() : '新会话',
        projectId: projectId ?? '',
        lastMessageAt: DateTime.now().millisecondsSinceEpoch,
      );
      sessions = [session, ...sessions];
      _notify();
      return session;
    }
    final session = await _client!.createSession(title: title, projectId: projectId);
    sessions = [session, ...sessions];
    _notify();
    return session;
  }

  Future<void> loadChanges() async {
    final session = currentSession;
    if (session == null) return;
    changesLoading = true;
    changesReason = null;
    _notify();
    if (demo || _client == null) {
      changes = [
        TurnChanges(
          changeId: 'demo-change-1',
          turnIndex: 3,
          createdAt: DateTime.now().millisecondsSinceEpoch,
          brief: '修复类型收窄',
          treeAvailable: true,
          files: const [
            ChangedFile(path: 'src/index.ts', status: 'M', additions: 42, deletions: 8),
            ChangedFile(path: 'src/styles.css', status: 'M', additions: 6, deletions: 2),
          ],
        ),
      ];
      changesLoading = false;
      _notify();
      return;
    }
    try {
      final result = await _client!.sessionChanges(session.id);
      changes = result.items;
      changesSupported = result.supported;
      changesReason = result.reason;
    } catch (e) {
      changes = const [];
      changesSupported = false;
      changesReason = _messageFor(e);
    } finally {
      changesLoading = false;
      _notify();
    }
  }

  Future<ChangeDiff?> loadDiff(TurnChanges change, ChangedFile file) async {
    if (demo || _client == null) {
      return ChangeDiff(
        path: file.path,
        status: file.status,
        patch: '--- a/${file.path}\n+++ b/${file.path}\n@@ -10,2 +10,2 @@\n-const value: number = port;\n+const value = Number(port);\n',
      );
    }
    try {
      return await _client!.sessionChangeDiff(currentSession!.id, change.changeId, file.path);
    } catch (e) {
      error = _messageFor(e);
      _notify();
      return null;
    }
  }

  Future<List<WorkspaceEntry>> listWorkspace(String path) async {
    if (demo || _client == null) {
      if (path.isEmpty) {
        return const [
          WorkspaceEntry(name: 'src', type: 'dir'),
          WorkspaceEntry(name: 'docs', type: 'dir'),
          WorkspaceEntry(name: 'package.json', type: 'file', size: 1024),
          WorkspaceEntry(name: 'README.md', type: 'file', size: 2048),
        ];
      }
      if (path == 'src') {
        return const [
          WorkspaceEntry(name: 'index.ts', type: 'file', size: 4096),
          WorkspaceEntry(name: 'styles.css', type: 'file', size: 8192),
        ];
      }
      return const [];
    }
    final host = activeHost;
    if (host == null) return const [];
    return _client!.workspaceList(path);
  }

  Future<WorkspaceFile> readWorkspace(String path) async {
    if (demo || _client == null) {
      return WorkspaceFile(
        path: path,
        text: path == 'src/index.ts'
            ? 'const port = parsePort(env.PORT);\nconst value = Number(port);\nif (!Number.isFinite(value)) {\n  throw new Error("invalid port");\n}\n'
            : '// $path\n',
      );
    }
    return _client!.workspaceRead(path);
  }

  Future<void> openSession(SessionSummary session) async {
    final sameSession = currentSession?.id == session.id;
    currentSession = session;
    if (!sameSession) approval = null;
    _notify();
    if (demo || _client == null) {
      messages = _demoMessages(session);
      _notify();
      return;
    }
    try {
      final got = await _client!.getSession(session.id);
      messages = got.messages;
      _eventSeq = got.eventSeq;
      try {
        final approvals = await _client!.listApprovals(session.id);
        approval = approvals.isEmpty ? null : approvals.first;
      } catch (_) {
        // 旧 Host 可能没有 approval.list；保留事件流里已有的卡片。
      }
      await _client!.watch(session.id, sinceSeq: _eventSeq > 0 ? _eventSeq - 20 : null);
      await _events?.cancel();
      _events = _client!.events(session.id, sinceSeq: _eventSeq > 0 ? _eventSeq : null).listen(
        _handleEvent,
        onError: (Object e) {
          error = '事件流断开：${_messageFor(e)}';
          _notify();
        },
        cancelOnError: false,
      );
    } catch (e) {
      error = _messageFor(e);
    }
    _notify();
  }

  Future<void> pickImage() async {
    if (!demo && !attachmentsSupported) {
      error = '当前主机没有开放附件上传（远程网关暂不支持），可以发文字或文件路径。';
      _notify();
      return;
    }
    try {
      final picked = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        maxWidth: 2048,
        imageQuality: 85,
      );
      if (picked == null) return;
      final bytes = await picked.readAsBytes();
      if (bytes.length > 8 * 1024 * 1024) {
        error = '图片超过 8MB，请压缩后再发';
        _notify();
        return;
      }
      final mime = picked.mimeType ?? 'image/jpeg';
      var id = '';
      if (!demo && _client != null) {
        id = await _client!.uploadAttachment(
          name: picked.name,
          mimeType: mime,
          base64: base64Encode(bytes),
        );
      }
      attachments = [
        ...attachments,
        PendingAttachment(id: id, name: picked.name, bytes: bytes.length, uploading: false),
      ];
      _notify();
    } catch (e) {
      error = '选择图片失败：$e';
      _notify();
    }
  }

  void removeAttachment(PendingAttachment attachment) {
    attachments = attachments.where((a) => a != attachment).toList();
    _notify();
  }

  Future<void> send(String text) async {
    final trimmed = text.trim();
    final session = currentSession;
    if (trimmed.isEmpty || session == null || running) return;
    error = null;
    messages = [
      ...messages,
      ChatMessage(
        id: 'local-${DateTime.now().microsecondsSinceEpoch}',
        role: 'user',
        content: trimmed,
        timestamp: DateTime.now().millisecondsSinceEpoch,
      ),
    ];
    running = true;
    _notify();
    if (demo || _client == null) {
      await Future<void>.delayed(const Duration(milliseconds: 350));
      messages = [
        ...messages,
        ChatMessage(
          id: 'demo-${DateTime.now().microsecondsSinceEpoch}',
          role: 'assistant',
          content: '收到。这是 N0 演示回复：连接真实 Host 后，这里会显示流式输出、工具卡和审批。',
          timestamp: DateTime.now().millisecondsSinceEpoch,
        ),
      ];
      running = false;
      attachments = [];
      _notify();
      return;
    }
    try {
      final ids = attachments.map((a) => a.id).where((id) => id.isNotEmpty).toList();
      runId = await _client!.sendPrompt(session.id, trimmed, attachmentIds: ids);
      attachments = [];
    } catch (e) {
      error = _messageFor(e);
      running = false;
      _notify();
    }
  }

  Future<void> stop() async {
    if (runId == null || _client == null) return;
    try {
      await _client!.cancel(runId!);
    } catch (e) {
      error = _messageFor(e);
    }
    _notify();
  }

  Future<void> shareSession() async {
    final session = currentSession;
    if (session == null) return;
    final tail = messages.where((m) => m.role != 'tool').take(20).map((m) => '${m.role}: ${m.content}').join('\n\n');
    await NativeBridge.shareText('Codem · ${session.title}\n${session.projectName ?? ''}\n\n$tail');
  }

  Future<void> respondApproval(bool allow) async {
    final request = approval;
    if (request == null || _client == null) return;
    try {
      await _client!.respondApproval(request.id, allow);
      approval = null;
      _notify();
    } catch (e) {
      error = _messageFor(e);
      _notify();
    }
  }

  void clearError() {
    error = null;
    _notify();
  }

  void setProjectFilter(String? id) {
    projectFilter = id;
    _notify();
  }

  List<SessionSummary> get visibleSessions {
    final filter = projectFilter;
    if (filter == null || filter.isEmpty) return sessions;
    return sessions.where((s) => s.projectId == filter).toList();
  }

  void _handleEvent(SessionEvent event) {
    if (event.seq > _eventSeq) _eventSeq = event.seq;
    switch (event.type) {
      case 'assistant.text':
        _appendAssistant(event.textDelta, reasoning: false);
        break;
      case 'assistant.reasoning':
        _appendAssistant(event.textDelta, reasoning: true);
        break;
      case 'tool.start':
        _upsertTool(
          ToolCallView(
            id: event.toolCallId.isEmpty ? 'tool-${event.seq}' : event.toolCallId,
            name: event.toolName,
            args: event.payload['args'],
            status: 'running',
          ),
        );
        break;
      case 'tool.end':
        _finishTool(
          event.toolCallId,
          status: event.payload['isError'] == true ? 'error' : 'done',
          result: event.payload['preview'],
        );
        break;
      case 'tool.error':
        _finishTool(event.toolCallId, status: 'error', result: event.payload['error']);
        break;
      case 'approval.requested':
        final raw = event.payload['approval'];
        if (raw is Map) {
          approval = ApprovalRequest.fromJson(Map<String, dynamic>.from(raw));
          if (approval != null) {
            NativeBridge.notify('Codem 需要审批', approval!.summary);
          }
        }
        break;
      case 'approval.resolved':
        approval = null;
        break;
      case 'run.started':
        running = true;
        break;
      case 'run.finished':
      case 'run.failed':
      case 'run.cancelled':
        running = false;
        runId = null;
        if (event.type == 'run.failed') error = (event.payload['error'] ?? '本轮运行失败').toString();
        break;
      case 'log':
        break;
    }
    _notify();
  }

  void _appendAssistant(String delta, {required bool reasoning}) {
    if (delta.isEmpty) return;
    if (messages.isEmpty || messages.last.role != 'assistant') {
      messages = [
        ...messages,
        ChatMessage(
          id: 'assistant-${DateTime.now().microsecondsSinceEpoch}',
          role: 'assistant',
          content: reasoning ? '' : delta,
          reasoning: reasoning ? delta : null,
          timestamp: DateTime.now().millisecondsSinceEpoch,
        ),
      ];
      return;
    }
    final last = messages.last;
    messages = [
      ...messages.take(messages.length - 1),
      reasoning
          ? last.copyWith(reasoning: '${last.reasoning ?? ''}$delta')
          : last.copyWith(content: '${last.content}$delta'),
    ];
  }

  void _upsertTool(ToolCallView tool) {
    if (messages.isEmpty || messages.last.role != 'assistant') {
      messages = [
        ...messages,
        ChatMessage(
          id: 'assistant-${DateTime.now().microsecondsSinceEpoch}',
          role: 'assistant',
          content: '',
          timestamp: DateTime.now().millisecondsSinceEpoch,
          toolCalls: [tool],
        ),
      ];
      return;
    }
    final last = messages.last;
    final existing = last.toolCalls.indexWhere((t) => t.id == tool.id);
    final tools = [...last.toolCalls];
    if (existing >= 0) {
      tools[existing] = tool;
    } else {
      tools.add(tool);
    }
    messages = [...messages.take(messages.length - 1), last.copyWith(toolCalls: tools)];
  }

  void _finishTool(String id, {required String status, dynamic result}) {
    if (messages.isEmpty) return;
    final last = messages.last;
    final index = last.toolCalls.indexWhere((t) => t.id == id);
    if (index < 0) return;
    final tools = [...last.toolCalls];
    tools[index] = tools[index].copyWith(status: status, result: result);
    messages = [...messages.take(messages.length - 1), last.copyWith(toolCalls: tools)];
  }

  void _seedDemo() {
    demo = true;
    attachmentsSupported = true;
    connected = false;
    connecting = false;
    activeHost = const HostProfile(
      id: 'demo-host',
      name: '我的 PC',
      baseUrl: 'http://127.0.0.1:41873',
      kind: HostKind.remote,
    );
    projects = const [
      ProjectSummary(id: 'p-codem', name: 'codem/app', path: 'D:/Project/codem'),
      ProjectSummary(id: 'p-api', name: 'api/pay', path: 'D:/Project/pay'),
    ];
    sessions = [
      SessionSummary(
        id: 'demo-42',
        title: '修复登录态丢失',
        projectId: 'p-codem',
        projectName: 'codem/app',
        lastMessageAt: DateTime.now().subtract(const Duration(minutes: 2)).millisecondsSinceEpoch,
        messageCount: 24,
        running: false,
        model: 'deepseek-flash',
      ),
      SessionSummary(
        id: 'demo-41',
        title: '重构支付回调',
        projectId: 'p-api',
        projectName: 'api/pay',
        lastMessageAt: DateTime.now().subtract(const Duration(days: 1)).millisecondsSinceEpoch,
        messageCount: 12,
        model: 'deepseek-flash',
      ),
      SessionSummary(
        id: 'demo-40',
        title: '把导出链路补上回归测试',
        projectId: 'p-codem',
        projectName: 'codem/app',
        lastMessageAt: DateTime.now().subtract(const Duration(days: 2)).millisecondsSinceEpoch,
        messageCount: 37,
      ),
    ];
    currentSession = null;
    messages = [];
    approval = null;
  }

  List<ChatMessage> _demoMessages(SessionSummary session) {
    final now = DateTime.now().millisecondsSinceEpoch;
    return [
      ChatMessage(
        id: 'd1',
        role: 'user',
        content: '文档写完了。再跑一遍 typecheck，输出贴我，TS2322 一并修掉。',
        timestamp: now - 60000,
      ),
      ChatMessage(
        id: 'd2',
        role: 'assistant',
        reasoning: '先确认 string | number 的来源，再决定只收窄声明还是调用方。',
        content: '先定位 src/index.ts 的类型错误，再跑完整检查。\n\n1. 读取 tsconfig 与报错文件，确认 string | number 的来源。\n2. 只改类型收窄，不动调用方的业务分支。\n3. 跑 npm run typecheck 与相关单测，贴出结果。',
        timestamp: now - 55000,
        toolCalls: [
          ToolCallView(
            id: 't1',
            name: 'bash',
            args: {'command': 'npm run typecheck'},
            result: '> tsc --noEmit\nsrc/index.ts:11:7 - error TS2322',
            status: 'error',
          ),
        ],
      ),
      ChatMessage(
        id: 'd3',
        role: 'assistant',
        content: '已定位：`const value: number = port`，而 `port` 是 `string | number`。改成 `Number(port)` 后重跑。',
        timestamp: now - 30000,
        toolCalls: [
          ToolCallView(
            id: 't2',
            name: 'edit',
            args: {'path': 'src/index.ts'},
            result: '+ const value = Number(port);',
            status: 'done',
          ),
        ],
      ),
    ];
  }

  String _messageFor(Object e) {
    if (e is HostRpcException) {
      if (e.unauthorized) return '连接未授权：请重新配对，或在桌面撤销后重新添加。';
      return e.message;
    }
    return e.toString();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _events?.cancel();
    _client?.close();
    super.dispose();
  }
}
