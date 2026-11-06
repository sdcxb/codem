import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'models.dart';

/// 主机列表 + 设备凭据。
///
/// N0 暂用 SharedPreferences 保存（含 cookie）；正式发布前换成 Android
/// Keystore/EncryptedSharedPreferences。这里先保证没有 native/NDK 依赖，
/// 让首个 APK 能构建出来。cookie 不写日志、不进导出。
class HostStore {
  static const _hostsKey = 'codem.hosts.v1';
  static const _cookiePrefix = 'codem.host.cookie.';
  static const _localProjectKey = 'codem.localHost.project';

  Future<List<HostProfile>> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_hostsKey);
    if (raw == null || raw.isEmpty) return <HostProfile>[];
    try {
      final list = jsonDecode(raw);
      if (list is! List) return <HostProfile>[];
      final hosts = <HostProfile>[];
      for (final item in list) {
        if (item is! Map) continue;
        final host = HostProfile.fromJson(Map<String, dynamic>.from(item));
        final cookie = prefs.getString('$_cookiePrefix${host.id}');
        hosts.add(cookie == null ? host : host.copyWith(cookie: cookie));
      }
      return hosts;
    } catch (_) {
      return <HostProfile>[];
    }
  }

  Future<void> save(List<HostProfile> hosts) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_hostsKey, jsonEncode(hosts.map((h) => h.toJson()).toList()));
    for (final host in hosts) {
      if (host.cookie != null && host.cookie!.isNotEmpty) {
        await prefs.setString('$_cookiePrefix${host.id}', host.cookie!);
      }
    }
  }

  Future<void> remove(HostProfile host) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('$_cookiePrefix${host.id}');
  }

  Future<void> saveCookie(HostProfile host, String cookie) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('$_cookiePrefix${host.id}', cookie);
  }

  /// 本机 Host 最近选择的项目（空字符串 = 工作区根）。
  ///
  /// 原生在 Host 停止时的 `status` 不带 `project`，这里留一份 Dart 侧记忆，
  /// 编辑页重新打开时能回填上次选择。
  Future<String?> loadLocalProject() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_localProjectKey);
  }

  Future<void> saveLocalProject(String name) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_localProjectKey, name);
  }
}
