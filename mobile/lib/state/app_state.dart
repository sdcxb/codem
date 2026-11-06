import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../data/host_client.dart';
import '../data/host_store.dart';
import '../data/models.dart';
import '../platform/local_host.dart';
import '../platform/native_bridge.dart';

/// 应用状态：主机、会话、消息、运行/审批。
///
/// N0 先内置 demo 数据，保证没有 Host 也能在真机审 UI；
/// 连接真实 Host 后 demo 自动退场。
class CodemAppState extends ChangeNotifier {
  CodemAppState({HostStore? store, LocalHostBridge? localHost})
      : _store = store ?? HostStore(),
        _localHost = localHost ?? LocalHostBridge();

  /// 仅用于 widget/golden 测试与设计评审：不读插件、不发网络。
  factory CodemAppState.preview() {
    final state = CodemAppState();
    state._seedDemo();
    state.booting = false;
    return state;
  }

  final HostStore _store;
  final LocalHostBridge _localHost;

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

  // ---- 本机 Host（Android 手机内置 Host）----
  //
  // 与远程主机连接状态分开：手机上的 Host 没启动不是「连接失败」，UI 要引导
  // 「启动本机 Host」，而不是弹红色错误。
  LocalHostStatus localHostStatus = LocalHostStatus.stopped;
  LocalHostModelConfig localModel = LocalHostModelConfig.empty;
  LocalHostStorageAccess? localHostStorage;
  List<String> localProjects = const [];
  String? localProject;
  String? localWorkspace;
  bool localHostBusy = false;
  bool localHostAvailable = true;
  bool localHostNeedsStart = false;
  bool localHostNeedsPermission = false;
  bool localHostCanRequestStorage = true;
  String? localHostError;

  HostClient? _client;
  StreamSubscription<SessionEvent>? _events;
  bool _disposed = false;
  int _eventSeq = 0;

  HostClient? get client => _client;

  /// 主机列表里的本机 Host（最多一条，`id` 固定为 `local-android`）。
  HostProfile? get localHostProfile {
    for (final host in hosts) {
      if (host.kind == HostKind.local) return host;
    }
    return null;
  }

  bool get localHostRunning => localHostStatus.running;

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
      final local = localHostProfile;
      if (local != null) {
        // 原生 Host 停止时 status 不带 project，先用 Dart 侧记忆回填上次选择。
        final rememberedProject = await _store.loadLocalProject();
        if (rememberedProject != null) localProject = rememberedProject;
        // 设置页要显示模型摘要（不回传 Key 明文）。
        await refreshLocalModel();
        // 本机 Host 的端口/令牌每次启动都会变：先问原生状态，running 才连。
        final running = await refreshLocalHostStatus();
        if (running && localHostStatus.connectable) {
          await connect(localHostProfile ?? local, silent: true);
          return;
        }
        // 没运行：先连其它（远程）主机，让 App 打开就能用；
        // 都没有时保留本机配置，只提示「启动本机 Host」，不报错。
        final remoteHosts = hosts.where((h) => h.kind != HostKind.local).toList();
        if (remoteHosts.isNotEmpty) {
          await connect(remoteHosts.first, silent: true);
        } else {
          activeHost = local;
          localHostNeedsStart = true;
          _notify();
        }
        return;
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
    var target = host;
    if (target.kind == HostKind.local) {
      final ready = await _ensureLocalHostReady();
      if (!ready) {
        // 手机上的 Host 没启动：保留配置，引导用户去启动，而不是弹「连接失败」。
        connecting = false;
        connected = false;
        demo = false;
        activeHost = localHostProfile ?? target;
        localHostNeedsStart = true;
        error = null;
        await _events?.cancel();
        _events = null;
        _client?.close();
        _client = null;
        await NativeBridge.stopForeground();
        _notify();
        return;
      }
      target = target.copyWith(
        baseUrl: localHostStatus.url.trim(),
        cookie: localHostStatus.token.trim(),
        online: true,
      );
    }
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
      baseUrl: target.baseUrl,
      // 本机 Host 的凭据是 Bearer 令牌（cookie 字段只是它的本地存储位置），
      // 不要再当成 HTTP cookie 发一遍。
      cookie: target.kind == HostKind.local ? null : target.cookie,
      bearerToken: target.kind == HostKind.local ? target.cookie : null,
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
      // 本机 Host 的 cookie 字段存的是 Bearer 令牌，不能被网关 cookie 覆盖。
      final isLocal = target.kind == HostKind.local;
      final freshCookie = isLocal ? null : _client!.currentCookie;
      final connectedHost = freshCookie == null ? target : target.copyWith(cookie: freshCookie);
      activeHost = connectedHost;
      connected = true;
      currentSession = null;
      messages = [];
      approval = null;
      hosts = hosts
          .map(
            (h) => h.id == target.id
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
      if (keepAwake) await NativeBridge.startForeground(target.name);
    } catch (e) {
      connected = false;
      activeHost = target;
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

  /// 本机 Host 的「能不能连」先问原生状态，避免把「没启动」当连接失败。
  Future<bool> _ensureLocalHostReady() async {
    if (localHostStatus.connectable) return true;
    await refreshLocalHostStatus();
    return localHostStatus.connectable;
  }

  Future<void> retry() async {
    final host = activeHost;
    if (host == null) return;
    await connect(host);
  }

  // ---- 本机 Host（Android）----

  /// 读原生 Host 状态。
  ///
  /// 返回是否 running。running 时会把 loopback 地址/令牌写回主机列表；
  /// 未运行时 `localHostNeedsStart = true`（UI 显示「启动本机 Host」），不算错误。
  Future<bool> refreshLocalHostStatus({bool syncProfile = true}) async {
    try {
      final status = await _localHost.status();
      localHostAvailable = true;
      localHostStatus = status;
      if (status.running) {
        localHostNeedsStart = false;
        localHostNeedsPermission = false;
        localHostError = null;
        if (status.workspace.isNotEmpty) localWorkspace = status.workspace;
        if (status.project.isNotEmpty) await _rememberLocalProject(status.project);
        if (syncProfile && status.connectable) {
          await _persistLocalEndpoint(status);
        } else {
          // 极端情况（缺 loopback 地址/令牌）也要引导用户重新启动，而不是以为已就绪。
          localHostNeedsStart = true;
        }
      } else {
        localHostNeedsStart = localHostProfile != null;
      }
      _notify();
      return status.running;
    } on LocalHostException catch (e) {
      if (e.unsupported) {
        // 桌面/测试环境没有原生实现：入口本身就不会展示，不制造错误。
        localHostAvailable = false;
        localHostNeedsStart = false;
        localHostError = null;
      } else {
        localHostAvailable = true;
        localHostError = e.message;
        localHostNeedsStart = localHostProfile != null;
        if (e.needsPermission) {
          localHostNeedsPermission = true;
          localHostCanRequestStorage = e.canRequestStorage;
        }
      }
      _notify();
      return false;
    } catch (e) {
      localHostError = '读取本机 Host 状态失败：$e';
      _notify();
      return false;
    }
  }

  /// 读原生已保存的模型配置（不含 Key 明文）。
  Future<void> refreshLocalModel() async {
    try {
      final config = await _localHost.modelConfig();
      localModel = config;
      _notify();
    } on LocalHostException catch (e) {
      if (!e.unsupported) {
        localHostError = e.message;
        _notify();
      }
    }
  }

  /// 读工作区里的项目名（下拉框数据源）。
  Future<void> refreshLocalProjects() async {
    try {
      localProjects = await _localHost.listProjects();
      _notify();
    } on LocalHostException catch (e) {
      if (!e.unsupported) {
        localHostError = e.message;
        _notify();
      }
    }
  }

  /// 保存模型配置但不启动。成功返回 true；失败保留已有配置，错误可直接展示。
  Future<bool> saveLocalModel({
    required String baseUrl,
    required String model,
    String apiKey = '',
  }) async {
    final config = LocalHostConfig(baseUrl: baseUrl, model: model, apiKey: apiKey);
    final validation = config.validate(
      requireApiKey: !(config.apiKey.trim().isEmpty && localModel.hasKey),
    );
    if (validation != null) {
      localHostError = validation;
      _notify();
      return false;
    }
    localHostBusy = true;
    _notify();
    try {
      await _localHost.saveModel(config);
      localModel = LocalHostModelConfig(
        baseUrl: config.baseUrl.trim(),
        model: config.model.trim(),
        hasKey: localModel.hasKey || config.hasApiKey,
      );
      localHostError = null;
      return true;
    } on LocalHostException catch (e) {
      // 保存失败仍记住服务地址/模型名（重开面板能回填），但不谎称 Key 已经存好。
      localModel = LocalHostModelConfig(
        baseUrl: config.baseUrl.trim(),
        model: config.model.trim(),
        hasKey: localModel.hasKey,
      );
      localHostError = e.message;
      return false;
    } finally {
      localHostBusy = false;
      _notify();
    }
  }

  /// 启动本机 Host：先 `saveModel` 再 `start`，成功后落成
  /// `HostProfile(kind: local, cookie: token)` 并直接连接 loopback。
  ///
  /// - 缺存储权限（原生返回 `needsPermission` 或抛权限异常）不算启动失败：
  ///   会设置 [localHostNeedsPermission]，配置保留，可授权后重试；
  /// - `allowPrivateFallback: true` 允许回退 App 私有目录（返回值 `shared:false`）。
  Future<bool> startLocalHost({
    required String baseUrl,
    required String model,
    String apiKey = '',
    bool allowPrivateFallback = false,
  }) async {
    final config = LocalHostConfig(baseUrl: baseUrl, model: model, apiKey: apiKey);
    final hasNewKey = config.apiKey.trim().isNotEmpty;
    final validation = config.validate(
      requireApiKey: !(!hasNewKey && localModel.hasKey),
    );
    if (validation != null) {
      localHostError = validation;
      _notify();
      return false;
    }
    localHostBusy = true;
    localHostError = null;
    localHostNeedsPermission = false;
    _notify();
    var keyPersisted = localModel.hasKey;
    try {
      // 启动前先落盘（Key 为空时原生沿用已保存的 Key）；失败时原生仍留有配置，方便重试。
      await _localHost.saveModel(config);
      if (hasNewKey) keyPersisted = true;
      final outcome = await _localHost.start(
        config,
        allowPrivateFallback: allowPrivateFallback,
      );
      if (outcome is LocalHostPermissionRequired) {
        localHostNeedsPermission = true;
        localHostCanRequestStorage = outcome.canRequest;
        localHostError = outcome.message;
        localHostNeedsStart = true;
        localModel = LocalHostModelConfig(
          baseUrl: config.baseUrl.trim(),
          model: config.model.trim(),
          hasKey: keyPersisted,
        );
        if (outcome.workspace.isNotEmpty) localWorkspace = outcome.workspace;
        return false;
      }
      if (outcome is LocalHostStarted) {
        final status = outcome.status;
        localHostStatus = status;
        if (status.workspace.isNotEmpty) localWorkspace = status.workspace;
        if (status.project.isNotEmpty) await _rememberLocalProject(status.project);
        if (!status.connectable) {
          localHostNeedsStart = true;
          localHostError = '本机 Host 已启动，但没有返回可连接的地址或令牌。请重试；若反复出现，请重启 App。';
          return false;
        }
        localHostNeedsPermission = false;
        localHostNeedsStart = false;
        localModel = LocalHostModelConfig(
          baseUrl: config.baseUrl.trim(),
          model: config.model.trim(),
          hasKey: true,
        );
        final profile = await _persistLocalEndpoint(status);
        await connect(profile);
        if (!connected) {
          // Host 起来了但 loopback 连不上：配置已保存，给可操作错误让用户重试。
          localHostError = error ?? '本机 Host 已启动，但连接 127.0.0.1 失败。请重试；仍失败可重启 App 后再启动。';
          return false;
        }
        return true;
      }
      return false;
    } on LocalHostException catch (e) {
      // 配置保留：错误文案已抹掉 Key，可直接展示并重试。
      localHostError = e.message;
      localHostNeedsPermission = e.needsPermission;
      localHostCanRequestStorage = e.canRequestStorage;
      localHostNeedsStart = localHostProfile != null;
      localModel = LocalHostModelConfig(
        baseUrl: config.baseUrl.trim(),
        model: config.model.trim(),
        hasKey: keyPersisted,
      );
      return false;
    } finally {
      localHostBusy = false;
      _notify();
    }
  }

  /// 停止本机 Host 并断开连接；主机配置保留，可再次启动。
  Future<void> stopLocalHost() async {
    localHostBusy = true;
    _notify();
    String? stopError;
    try {
      await _localHost.stop();
    } on LocalHostException catch (e) {
      // 停止失败也要把 UI 状态收回到「未运行」，否则用户以为还连着。
      stopError = e.message;
    } finally {
      localHostStatus = LocalHostStatus.stopped;
      localHostNeedsPermission = false;
      localWorkspace = '';
      localHostError = stopError;
      localHostNeedsStart = localHostProfile != null;
      await _disconnect();
      hosts = hosts
          .map((h) => h.kind == HostKind.local ? h.copyWith(online: false) : h)
          .toList();
      await _store.save(hosts);
      localHostBusy = false;
      _notify();
    }
  }

  /// 选择本机工作区里的项目（空字符串 = 根目录）；只记录选择，下次 start 生效。
  Future<bool> setLocalProject(String name) async {
    try {
      final value = name.trim();
      await _localHost.setProject(value);
      await _rememberLocalProject(value);
      localHostError = null;
      _notify();
      return true;
    } on LocalHostException catch (e) {
      localHostError = e.message;
      _notify();
      return false;
    }
  }

  /// 引导共享存储授权。
  ///
  /// 原生 `requestStorageAccess` 返回 `true` = 现在已可写（可直接重试 [startLocalHost]）；
  /// `false` = 已打开系统授权页/弹出运行时申请，需要回前台用
  /// [refreshLocalHostStorageAccess] 复查后再重试。Key 不在 state 里，重试由 UI 发起。
  Future<bool> requestLocalHostStorageAccess() async {
    try {
      final access = await _localHost.requestStorageAccess();
      localHostStorage = access;
      if (access.granted) {
        localHostNeedsPermission = false;
        localHostError = null;
      } else {
        localHostNeedsPermission = true;
        localHostError = '已打开系统授权页：授权后回到 Codem 会自动复查，然后可以重试启动。';
      }
      _notify();
      return access.granted;
    } on LocalHostException catch (e) {
      localHostError = e.message;
      _notify();
      return false;
    }
  }

  /// 回到前台后复查共享存储授权（原生 `storageAccess`）。
  ///
  /// 返回是否已可写；已可写时清掉「待授权」，UI 可自动重试启动。
  Future<bool> refreshLocalHostStorageAccess() async {
    try {
      final access = await _localHost.storageAccess();
      localHostStorage = access;
      if (access.granted) {
        localHostNeedsPermission = false;
        localHostError = null;
        if (access.workspace.isNotEmpty) localWorkspace = access.workspace;
        _notify();
        return true;
      }
      _notify();
      return false;
    } on LocalHostException catch (e) {
      if (!e.unsupported) {
        localHostError = e.message;
        _notify();
      }
      return false;
    }
  }

  /// 记住本机 Host 当前项目（原生 Host 停止时 status 不带 project）。
  Future<void> _rememberLocalProject(String name) async {
    localProject = name;
    await _store.saveLocalProject(name);
  }

  Future<HostProfile> _persistLocalEndpoint(LocalHostStatus status) async {
    final existing = localHostProfile;
    final token = status.token.trim();
    final profile = HostProfile(
      id: existing?.id ?? 'local-android',
      name: existing?.name ?? '本机 Host',
      baseUrl: status.url.trim(),
      kind: HostKind.local,
      online: true,
      lastSeenAt: DateTime.now().millisecondsSinceEpoch,
      cookie: token.isEmpty ? existing?.cookie : token,
    );
    hosts = existing == null
        ? [profile, ...hosts]
        : hosts.map((h) => h.id == existing.id ? profile : h).toList();
    if (activeHost == null || activeHost?.kind == HostKind.local) activeHost = profile;
    await _store.save(hosts);
    final savedToken = profile.cookie;
    if (savedToken != null && savedToken.isNotEmpty) {
      await _store.saveCookie(profile, savedToken);
    }
    return profile;
  }

  Future<void> _disconnect() async {
    await _events?.cancel();
    _events = null;
    _client?.close();
    _client = null;
    connected = false;
    attachmentsSupported = false;
    await NativeBridge.stopForeground();
  }

  Future<void> removeHost(HostProfile host) async {
    if (host.kind == HostKind.local) {
      // 删掉入口就别把原生 Host 留在后台跑。
      try {
        await _localHost.stop();
      } catch (_) {
        // 原生没实现/已停止都无所谓。
      }
      localHostStatus = LocalHostStatus.stopped;
      localHostNeedsStart = false;
      localHostNeedsPermission = false;
      localWorkspace = '';
    }
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
