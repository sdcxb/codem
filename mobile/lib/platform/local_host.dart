import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// 本机 Host（Android 手机内置 PRoot/Ubuntu/Codem Host）的 Dart 侧桥。
///
/// 契约：`mobile/LOCAL_HOST_CONTRACT.md`，Channel `codem/local_host`。
/// 原生实现目前只有 Android 有：其它平台调用会抛 [LocalHostException]
/// （`unsupported: true`），入口是否展示由 [LocalHostBridge.platformSupported] 决定。
///
/// 约定：
/// - API Key 只在 MethodChannel 参数里出现一次，不进日志、不进 `toString`、不进错误文案；
/// - 任何来自原生的错误文本都会经过 [redactLocalHostText] 再展示；
/// - 存储权限缺失不算「启动失败」，用 [LocalHostPermissionRequired] 表达，
///   允许用户「去授权」后重试，或带 `allowPrivateFallback: true` 回退私有目录。
const String kLocalHostChannelName = 'codem/local_host';

/// 原生 `start` 成功时可能带的额外字段：工作区是否在共享存储。
///
/// `shared: false` 表示回退到 App 私有目录（其它 App / 文件管理器看不到项目文件），
/// 仍可正常用，但 UI 要如实提示。
@immutable
class LocalHostStatus {
  const LocalHostStatus({
    this.running = false,
    this.url = '',
    this.token = '',
    this.workspace = '',
    this.project = '',
    this.shared,
    this.storageGranted,
  });

  static const LocalHostStatus stopped = LocalHostStatus();

  final bool running;
  final String url;
  final String token;
  final String workspace;
  final String project;

  /// `null` = 原生没返回该字段（旧版本），UI 不要擅自断言共享/私有。
  final bool? shared;

  /// `null` = 未知；false 表示共享存储权限没给。
  final bool? storageGranted;

  bool get hasUrl => url.trim().isNotEmpty;

  /// 能直接 `HostClient` 连上的最小条件：地址 + 令牌都在。
  bool get connectable => running && hasUrl && token.trim().isNotEmpty;

  LocalHostStatus copyWith({
    bool? running,
    String? url,
    String? token,
    String? workspace,
    String? project,
    bool? shared,
    bool? storageGranted,
  }) {
    return LocalHostStatus(
      running: running ?? this.running,
      url: url ?? this.url,
      token: token ?? this.token,
      workspace: workspace ?? this.workspace,
      project: project ?? this.project,
      shared: shared ?? this.shared,
      storageGranted: storageGranted ?? this.storageGranted,
    );
  }

  /// 解析 `status` / `start` 的返回：`start` 不带 `running` 字段，按 url/token 推断。
  factory LocalHostStatus.fromMap(Object? raw) {
    final map = _asMap(raw);
    final url = _string(map['url']);
    final token = _string(map['token']);
    final runningRaw = map['running'];
    final running = runningRaw is bool ? runningRaw : (url.isNotEmpty || token.isNotEmpty);
    final storage = map['storage'] is Map
        ? Map<String, dynamic>.from(map['storage'] as Map)
        : const <String, dynamic>{};
    final grantedRaw = map['storageGranted'] ?? storage['granted'];
    return LocalHostStatus(
      running: running,
      url: url,
      token: token,
      workspace: _string(map['workspace']),
      project: _string(map['project']),
      shared: map['shared'] is bool ? map['shared'] as bool : null,
      storageGranted: grantedRaw is bool ? grantedRaw : null,
    );
  }

  @override
  String toString() =>
      'LocalHostStatus(running: $running, url: $url, workspace: $workspace, hasToken: ${token.isNotEmpty})';
}

/// 原生 `modelConfig` 返回：不回传 Key 明文，只给 `hasKey`。
@immutable
class LocalHostModelConfig {
  const LocalHostModelConfig({
    this.baseUrl = '',
    this.model = '',
    this.hasKey = false,
    this.configured = false,
    this.keyState = '',
    this.insecureHttp = false,
  });

  static const LocalHostModelConfig empty = LocalHostModelConfig();

  final String baseUrl;
  final String model;
  final bool hasKey;

  /// 原生扩展字段：是否已经有可用模型配置。
  final bool configured;

  /// 原生扩展字段：`keystore|legacy|unreadable|none`，`unreadable` 表示 Key 解不开。
  final String keyState;

  /// 原生扩展字段：模型服务地址不是 https。
  final bool insecureHttp;

  factory LocalHostModelConfig.fromMap(Object? raw) {
    final map = _asMap(raw);
    final hasKey = map['hasKey'] == true;
    return LocalHostModelConfig(
      baseUrl: _string(map['baseUrl']),
      model: _string(map['model']),
      hasKey: hasKey,
      configured: map['configured'] == true || hasKey,
      keyState: _string(map['keyState']),
      insecureHttp: map['insecureHttp'] == true,
    );
  }

  @override
  String toString() =>
      'LocalHostModelConfig(baseUrl: $baseUrl, model: $model, hasKey: $hasKey, keyState: $keyState)';
}

/// 原生 `storageAccess` 查询结果。
@immutable
class LocalHostStorageAccess {
  const LocalHostStorageAccess({
    this.granted = false,
    this.awaitingUser = false,
    this.permission = '',
    this.shared,
    this.workspace = '',
  });

  /// 现在是否真的可写共享存储（原生会实际写探针文件）。
  final bool granted;

  /// `requestStorageAccess` 只是打开了系统授权页/弹出申请，需要回前台后复查。
  final bool awaitingUser;
  final String permission;
  final bool? shared;
  final String workspace;

  factory LocalHostStorageAccess.fromMap(Object? raw) {
    if (raw is bool) return LocalHostStorageAccess(granted: raw);
    final map = _asMap(raw);
    bool? flag(String key) => map[key] is bool ? map[key] as bool : null;
    final granted = flag('granted') ??
        flag('manageAllFiles') ??
        flag('writeGranted') ??
        (map['shared'] == true);
    return LocalHostStorageAccess(
      granted: granted,
      permission: _string(map['permission']),
      shared: map['shared'] is bool ? map['shared'] as bool : null,
      workspace: _string(map['workspace'] ?? map['sharedWorkspace']),
    );
  }

  @override
  String toString() =>
      'LocalHostStorageAccess(granted: $granted, awaitingUser: $awaitingUser, workspace: $workspace)';
}

/// 模型服务配置（纯 Dart 值对象，便于不依赖平台通道做单测）。
///
/// 注意：`apiKey` 只在内存里短暂存在，`toString` 永不输出明文。
@immutable
class LocalHostConfig {
  const LocalHostConfig({
    required this.baseUrl,
    required this.model,
    this.apiKey = '',
  });

  static const String defaultBaseUrl = 'https://api.aicodewith.ai/v1';
  static const String defaultModel = 'deepseek-v4-flash';

  final String baseUrl;
  final String model;
  final String apiKey;

  LocalHostConfig copyWith({String? baseUrl, String? model, String? apiKey}) {
    return LocalHostConfig(
      baseUrl: baseUrl ?? this.baseUrl,
      model: model ?? this.model,
      apiKey: apiKey ?? this.apiKey,
    );
  }

  bool get hasApiKey => apiKey.trim().isNotEmpty;

  /// 校验配置；合法时返回 `null`，否则返回可直接展示的中文提示。
  ///
  /// `requireApiKey: false` 用于「原生已保存 Key，这次留空沿用」的情形。
  String? validate({bool requireApiKey = true}) {
    final url = baseUrl.trim();
    if (url.isEmpty) return '请填写模型服务地址（例如 $defaultBaseUrl）';
    final uri = Uri.tryParse(url);
    if (uri == null || !(uri.isScheme('http') || uri.isScheme('https'))) {
      return '模型服务地址必须以 http:// 或 https:// 开头';
    }
    if (model.trim().isEmpty) return '请填写模型名（例如 $defaultModel）';
    if (requireApiKey && apiKey.trim().isEmpty) {
      return '请填写 API Key（只保存在这台手机上，不会上传到 Codem 服务器）';
    }
    return null;
  }

  Map<String, dynamic> toMap({bool includeApiKey = true}) {
    return <String, dynamic>{
      'baseUrl': baseUrl.trim(),
      'model': model.trim(),
      if (includeApiKey && apiKey.trim().isNotEmpty) 'apiKey': apiKey.trim(),
    };
  }

  @override
  String toString() =>
      'LocalHostConfig(baseUrl: $baseUrl, model: $model, hasKey: $hasApiKey)';
}

/// `start` 的结果：要么起来了，要么缺存储权限（缺权限不是失败）。
sealed class LocalHostStartOutcome {
  const LocalHostStartOutcome();
}

class LocalHostStarted extends LocalHostStartOutcome {
  const LocalHostStarted(this.status);

  final LocalHostStatus status;
}

/// 原生返回 `{needsPermission: true, permission, workspace, storage:{granted:false}}`。
class LocalHostPermissionRequired extends LocalHostStartOutcome {
  const LocalHostPermissionRequired({
    required this.message,
    this.permission = '',
    this.canRequest = true,
    this.workspace = '',
    this.storageGranted,
  });

  factory LocalHostPermissionRequired.fromMap(
    Map<String, dynamic> map, {
    String? secret,
  }) {
    final permission = _string(map['permission']);
    final storage = map['storage'] is Map
        ? Map<String, dynamic>.from(map['storage'] as Map)
        : const <String, dynamic>{};
    final grantedRaw = map['storageGranted'] ?? storage['granted'];
    final rawMessage = _string(map['message']);
    return LocalHostPermissionRequired(
      message: rawMessage.isEmpty
          ? permissionMessage(permission)
          : redactLocalHostText(rawMessage, secret: secret),
      permission: permission,
      canRequest: map['canRequest'] != false,
      workspace: _string(map['workspace']),
      storageGranted: grantedRaw is bool ? grantedRaw : null,
    );
  }

  final String message;
  final String permission;
  final bool canRequest;
  final String workspace;
  final bool? storageGranted;
}

/// 按原生 `permission` 字段给用户更具体的说法（Android 11+ 与旧版不同）。
String permissionMessage(String permission) {
  switch (permission) {
    case 'manage_external_storage':
      return '需要开启「所有文件访问」权限，才能读写手机上的项目目录。'
          '授权后会自动重试；不授权也可以改用 App 私有工作区继续用。';
    case 'write_external_storage':
      return '需要「存储」权限，才能读写手机上的项目目录。'
          '授权后会自动重试；不授权也可以改用 App 私有工作区继续用。';
    default:
      return '需要存储权限，才能读写手机上的项目目录。'
          '授权后会自动重试；不授权也可以改用 App 私有工作区继续用。';
  }
}

/// 本机 Host 的可读错误（中文、可操作）。
class LocalHostException implements Exception {
  const LocalHostException(
    this.message, {
    this.code = 'unknown',
    this.retryable = false,
    this.needsPermission = false,
    this.canRequestStorage = true,
    this.unsupported = false,
  });

  /// 可直接展示给用户的中文说明（已抹掉 Key）。
  final String message;
  final String code;
  final bool retryable;
  final bool needsPermission;
  final bool canRequestStorage;

  /// 设备上没有原生实现（桌面/iOS/测试环境）。
  final bool unsupported;

  /// 把 `PlatformException` 翻成中文可操作提示；绝不把 Key 拼进文案。
  factory LocalHostException.fromPlatformException(
    PlatformException e, {
    String? secret,
  }) {
    final code = e.code.toLowerCase();
    final details = e.details is Map
        ? Map<String, dynamic>.from(e.details as Map)
        : const <String, dynamic>{};
    final detail = redactLocalHostText((e.message ?? '').trim(), secret: secret);
    final permission = _string(details['permission']);
    final canRequest = details['canRequest'] != false;

    final needsPermission = code.contains('permission') ||
        code == 'needspermission' ||
        code.contains('storage_access') ||
        permission.isNotEmpty ||
        detail.contains('MANAGE_EXTERNAL_STORAGE') ||
        detail.contains('WRITE_EXTERNAL_STORAGE');
    if (needsPermission) {
      return LocalHostException(
        detail.isNotEmpty
            ? detail
            : permissionMessage(permission),
        code: e.code,
        retryable: true,
        needsPermission: true,
        canRequestStorage: canRequest,
      );
    }

    if (code.contains('unsupported') ||
        code.contains('unavailable') ||
        code.contains('noplugin') ||
        code.contains('channel-error')) {
      return LocalHostException(
        '这台设备上没有本机 Host 能力：需要 Android 版 Codem（系统版本受支持）。',
        code: e.code,
        unsupported: true,
      );
    }

    if (code.contains('apikey') || code.contains('api_key') || code.contains('missingkey')) {
      return LocalHostException(
        detail.isNotEmpty ? detail : '还没有可用的 API Key：请在下方重新填写后启动。',
        code: e.code,
        retryable: true,
      );
    }

    if (code.contains('config') || code.contains('invalid')) {
      return LocalHostException(
        detail.isNotEmpty ? detail : '模型配置不完整：请检查模型服务地址、模型名和 API Key。',
        code: e.code,
        retryable: true,
      );
    }

    if (code.contains('start') || code.contains('boot') || code.contains('timeout')) {
      return LocalHostException(
        detail.isNotEmpty
            ? detail
            : '本机 Host 启动失败。可以直接重试；如果一直失败，请检查网络后重启 App。',
        code: e.code,
        retryable: true,
      );
    }

    if (code.contains('runtime')) {
      return LocalHostException(
        detail.isNotEmpty
            ? detail
            : '运行环境安装失败：可能是存储空间不足或 CPU 架构不受支持。请清理空间后重试，或重新安装 App。',
        code: e.code,
        retryable: true,
      );
    }

    if (code.contains('host')) {
      return LocalHostException(
        detail.isNotEmpty
            ? detail
            : '本机 Host 没能在 120 秒内就绪。可以直接重试；若反复失败，重启 App 后再启动。',
        code: e.code,
        retryable: true,
      );
    }

    return LocalHostException(
      detail.isNotEmpty ? detail : '本机 Host 操作失败（${e.code}）。请重试。',
      code: e.code,
      retryable: true,
    );
  }

  @override
  String toString() => message;
}

/// 把错误文本里的 API Key 抹掉。
///
/// 原生实现本不该回传 Key；这里再兜一道，保证 UI/SnackBar 不会显示明文。
String redactLocalHostText(String text, {String? secret}) {
  var out = text;
  final s = secret?.trim();
  if (s != null && s.length >= 6) out = out.replaceAll(s, '***');
  out = out.replaceAll(RegExp(r'sk-[A-Za-z0-9_\-]{4,}'), 'sk-***');
  return out;
}

/// 真正的 MethodChannel 封装。
///
/// 测试里通过对 [channel] 注册 `TestDefaultBinaryMessenger` 打桩；
/// 也可以注入一个自建 channel。
class LocalHostBridge {
  LocalHostBridge({MethodChannel? channel})
      : _channel = channel ?? const MethodChannel(kLocalHostChannelName);

  /// 测试用：`setMockMethodCallHandler(LocalHostBridge.channel, ...)`。
  static const MethodChannel channel = MethodChannel(kLocalHostChannelName);

  /// 入口是否展示：本机 Host 只有 Android 有原生实现。
  static bool get platformSupported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  final MethodChannel _channel;

  Future<LocalHostStatus> status() async {
    return LocalHostStatus.fromMap(await _invoke('status'));
  }

  Future<LocalHostModelConfig> modelConfig() async {
    return LocalHostModelConfig.fromMap(await _invoke('modelConfig'));
  }

  Future<List<String>> listProjects() async {
    return _parseProjectList(await _invoke('listProjects'));
  }

  Future<void> setProject(String name) async {
    await _invoke('setProject', <String, dynamic>{'name': name.trim()});
  }

  /// 只保存模型配置、不启动 Host。
  Future<void> saveModel(LocalHostConfig config) async {
    await _invoke('saveModel', config.toMap());
  }

  /// 启动本机 Host。
  ///
  /// `apiKey` 为空时不传该字段：原生会沿用已保存的 Key（见 LocalHostRuntime.applyModel）。
  /// `allowPrivateFallback: true` 允许回退 App 私有目录（返回值 `shared:false`）。
  Future<LocalHostStartOutcome> start(
    LocalHostConfig config, {
    bool allowPrivateFallback = false,
  }) async {
    final args = <String, dynamic>{
      ...config.toMap(),
      if (allowPrivateFallback) 'allowPrivateFallback': true,
    };
    final map = _asMap(await _invoke('start', args));
    if (map['needsPermission'] == true) {
      return LocalHostPermissionRequired.fromMap(map, secret: config.apiKey);
    }
    return LocalHostStarted(LocalHostStatus.fromMap(map));
  }

  Future<void> stop() async {
    await _invoke('stop');
  }

  /// 查询共享存储授权状态；老实现只回 bool 也能解析。
  Future<LocalHostStorageAccess> storageAccess() async {
    return LocalHostStorageAccess.fromMap(await _invoke('storageAccess'));
  }

  /// 引导共享存储授权。
  ///
  /// 原生语义（见 `mobile/android/LOCAL_HOST_CONTRACT_ADDENDUM.md`）：
  /// - `true`：现在已可写，可直接重试 `start`；
  /// - `false`：已打开系统授权页/弹出运行时申请，回前台后先 [storageAccess] 复查。
  Future<LocalHostStorageAccess> requestStorageAccess() async {
    final raw = await _invoke('requestStorageAccess');
    if (raw is bool) {
      return LocalHostStorageAccess(granted: raw, awaitingUser: !raw);
    }
    final access = LocalHostStorageAccess.fromMap(raw);
    return LocalHostStorageAccess(
      granted: access.granted,
      awaitingUser: !access.granted,
      permission: access.permission,
      shared: access.shared,
      workspace: access.workspace,
    );
  }

  Future<Object?> _invoke(String method, [Object? arguments]) async {
    try {
      return await _channel.invokeMethod<Object?>(method, arguments);
    } on MissingPluginException {
      throw const LocalHostException(
        '这台设备上没有本机 Host 能力：需要 Android 版 Codem（系统版本受支持）。',
        code: 'unsupported',
        unsupported: true,
      );
    } on PlatformException catch (e) {
      throw LocalHostException.fromPlatformException(e, secret: _secretIn(arguments));
    }
  }
}

String? _secretIn(Object? arguments) {
  if (arguments is Map) {
    final key = arguments['apiKey'];
    if (key is String && key.trim().isNotEmpty) return key.trim();
  }
  return null;
}

List<String> _parseProjectList(Object? raw) {
  if (raw is! List) return const <String>[];
  final names = <String>[];
  for (final item in raw) {
    final String name;
    if (item is Map) {
      name = _string(item['name']);
      if (name.isEmpty) continue;
    } else {
      name = _string(item);
    }
    if (!names.contains(name)) names.add(name);
  }
  return names;
}

Map<String, dynamic> _asMap(Object? raw) {
  if (raw is Map) return Map<String, dynamic>.from(raw);
  return const <String, dynamic>{};
}

String _string(Object? value) {
  if (value == null) return '';
  return value.toString().trim();
}
