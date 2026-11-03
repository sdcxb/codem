import 'package:flutter/services.dart';

/// Android 原生能力桥（前台服务/系统分享）。
///
/// 非 Android 平台或测试环境没有这个 channel：所有调用都吞掉 MissingPlugin，
/// UI 不能因为“桌面预览没有服务”而失败。
class NativeBridge {
  static const MethodChannel _channel = MethodChannel('codem/native');

  static Future<void> startForeground(String label) async {
    try {
      await _channel.invokeMethod<void>('startForeground', {'label': label});
    } on MissingPluginException {
      // 测试/桌面预览：无原生实现。
    } on PlatformException {
      // 前台服务失败不应阻断聊天；系统会在日志里留下原因。
    }
  }

  static Future<void> stopForeground() async {
    try {
      await _channel.invokeMethod<void>('stopForeground');
    } on MissingPluginException {
      // ignore
    } on PlatformException {
      // ignore
    }
  }

  static Future<void> shareText(String text) async {
    try {
      await _channel.invokeMethod<void>('shareText', {'text': text});
    } on MissingPluginException {
      // ignore
    } on PlatformException {
      // ignore
    }
  }

  static Future<void> notify(String title, String body) async {
    try {
      await _channel.invokeMethod<void>('notify', {'title': title, 'body': body});
    } on MissingPluginException {
      // ignore
    } on PlatformException {
      // ignore
    }
  }
}
