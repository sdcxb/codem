import 'package:intl/intl.dart';

String relativeTime(int timestamp) {
  if (timestamp <= 0) return '';
  final diff = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(timestamp));
  if (diff.inSeconds < 45) return '刚刚';
  if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
  if (diff.inHours < 24) return '${diff.inHours} 小时前';
  if (diff.inDays == 1) return '昨天';
  if (diff.inDays < 7) return '${diff.inDays} 天前';
  return DateFormat('MM-dd').format(DateTime.fromMillisecondsSinceEpoch(timestamp));
}

String shortPath(String path) {
  final normalized = path.replaceAll('\\', '/');
  final parts = normalized.split('/').where((p) => p.isNotEmpty).toList();
  if (parts.length <= 2) return normalized;
  return '${parts[parts.length - 2]}/${parts[parts.length - 1]}';
}

String clipMiddle(String text, {int max = 60}) {
  if (text.length <= max) return text;
  final keep = (max - 1) ~/ 2;
  return '${text.substring(0, keep)}…${text.substring(text.length - keep)}';
}
