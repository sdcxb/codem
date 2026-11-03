import 'dart:convert';

/// Host 设备类型：本机 Host / Tailscale 远程 Host。
enum HostKind { local, remote }

class HostProfile {
  const HostProfile({
    required this.id,
    required this.name,
    required this.baseUrl,
    required this.kind,
    this.online = true,
    this.lastSeenAt,
    this.cookie,
  });

  final String id;
  final String name;
  final String baseUrl;
  final HostKind kind;
  final bool online;
  final int? lastSeenAt;

  /// 远程设备凭据（HttpOnly cookie 的客户端存储；不进日志）。
  final String? cookie;

  HostProfile copyWith({bool? online, int? lastSeenAt, String? cookie, String? name}) {
    return HostProfile(
      id: id,
      name: name ?? this.name,
      baseUrl: baseUrl,
      kind: kind,
      online: online ?? this.online,
      lastSeenAt: lastSeenAt ?? this.lastSeenAt,
      cookie: cookie ?? this.cookie,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'baseUrl': baseUrl,
        'kind': kind.name,
        if (lastSeenAt != null) 'lastSeenAt': lastSeenAt,
      };

  static HostProfile fromJson(Map<String, dynamic> json) => HostProfile(
        id: json['id'] as String,
        name: json['name'] as String? ?? '我的电脑',
        baseUrl: json['baseUrl'] as String,
        kind: HostKind.values.firstWhere(
          (k) => k.name == json['kind'],
          orElse: () => HostKind.remote,
        ),
        lastSeenAt: json['lastSeenAt'] as int?,
      );
}

class SessionSummary {
  const SessionSummary({
    required this.id,
    required this.title,
    this.projectId = '',
    this.projectName,
    this.lastMessageAt = 0,
    this.messageCount = 0,
    this.running = false,
    this.model,
  });

  final String id;
  final String title;
  final String projectId;
  final String? projectName;
  final int lastMessageAt;
  final int messageCount;
  final bool running;
  final String? model;

  factory SessionSummary.fromJson(Map<String, dynamic> json) => SessionSummary(
        id: json['id'] as String,
        title: (json['title'] as String?)?.trim().isNotEmpty == true
            ? json['title'] as String
            : '未命名会话',
        projectId: json['projectId'] as String? ?? '',
        lastMessageAt: (json['lastMessageAt'] as num?)?.toInt() ?? 0,
        messageCount: (json['messageCount'] as num?)?.toInt() ?? 0,
        running: json['running'] == true,
        model: json['model'] as String?,
      );
}

class ToolCallView {
  const ToolCallView({
    required this.id,
    required this.name,
    this.args,
    this.result,
    this.status = 'running',
  });

  final String id;
  final String name;
  final dynamic args;
  final dynamic result;
  final String status;

  ToolCallView copyWith({dynamic result, String? status}) => ToolCallView(
        id: id,
        name: name,
        args: args,
        result: result ?? this.result,
        status: status ?? this.status,
      );
}

class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.role,
    required this.content,
    required this.timestamp,
    this.reasoning,
    this.toolCalls = const [],
    this.status,
  });

  final String id;
  final String role;
  final String content;
  final int timestamp;
  final String? reasoning;
  final List<ToolCallView> toolCalls;
  final String? status;

  bool get isUser => role == 'user';

  ChatMessage copyWith({
    String? content,
    String? reasoning,
    List<ToolCallView>? toolCalls,
    String? status,
  }) =>
      ChatMessage(
        id: id,
        role: role,
        content: content ?? this.content,
        timestamp: timestamp,
        reasoning: reasoning ?? this.reasoning,
        toolCalls: toolCalls ?? this.toolCalls,
        status: status ?? this.status,
      );

  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    final rawTools = json['toolCalls'];
    final tools = <ToolCallView>[];
    if (rawTools is List) {
      for (final item in rawTools) {
        if (item is Map) {
          final map = Map<String, dynamic>.from(item);
          tools.add(ToolCallView(
            id: map['id'] as String? ?? '',
            name: map['tool'] as String? ?? 'tool',
            args: map['args'],
            result: map['result'],
            status: map['status'] as String? ?? 'done',
          ));
        }
      }
    }
    return ChatMessage(
      id: json['id'] as String? ?? '',
      role: json['role'] as String? ?? 'assistant',
      content: json['content'] as String? ?? '',
      timestamp: (json['timestamp'] as num?)?.toInt() ?? 0,
      reasoning: json['reasoning'] as String?,
      toolCalls: tools,
      status: json['status'] as String?,
    );
  }
}

class ApprovalRequest {
  const ApprovalRequest({
    required this.id,
    required this.sessionId,
    required this.tool,
    required this.summary,
    this.details,
    this.createdAt = 0,
  });

  final String id;
  final String sessionId;
  final String tool;
  final String summary;
  final Map<String, dynamic>? details;
  final int createdAt;

  factory ApprovalRequest.fromJson(Map<String, dynamic> json) => ApprovalRequest(
        id: json['approvalId'] as String? ?? json['id'] as String? ?? '',
        sessionId: json['sessionId'] as String? ?? '',
        tool: json['tool'] as String? ?? 'tool',
        summary: json['summary'] as String? ?? '需要确认',
        details: json['details'] is Map ? Map<String, dynamic>.from(json['details'] as Map) : null,
        createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
      );
}

class SessionEvent {
  const SessionEvent({
    required this.seq,
    required this.sessionId,
    required this.type,
    required this.payload,
    this.runId,
    this.timestamp = 0,
  });

  final int seq;
  final String sessionId;
  final String type;
  final Map<String, dynamic> payload;
  final String? runId;
  final int timestamp;

  factory SessionEvent.fromJson(Map<String, dynamic> json) => SessionEvent(
        seq: (json['seq'] as num?)?.toInt() ?? 0,
        sessionId: json['sessionId'] as String? ?? '',
        type: json['type'] as String? ?? 'log',
        payload: json['payload'] is Map ? Map<String, dynamic>.from(json['payload'] as Map) : const {},
        runId: json['runId'] as String?,
        timestamp: (json['timestamp'] as num?)?.toInt() ?? 0,
      );

  String get textDelta =>
      (payload['text'] ?? payload['delta'] ?? payload['content'] ?? '').toString();

  String get toolName => (payload['tool'] ?? payload['name'] ?? 'tool').toString();
  String get toolCallId => (payload['toolCallId'] ?? payload['id'] ?? '').toString();

  static Map<String, dynamic> decodePayload(Object? value) {
    if (value is Map) return Map<String, dynamic>.from(value);
    if (value is String && value.isNotEmpty) {
      try {
        final decoded = jsonDecode(value);
        if (decoded is Map) return Map<String, dynamic>.from(decoded);
      } catch (_) {}
    }
    return const {};
  }
}

class ProjectSummary {
  const ProjectSummary({
    required this.id,
    required this.name,
    this.path = '',
  });

  final String id;
  final String name;
  final String path;

  factory ProjectSummary.fromJson(Map<String, dynamic> json) => ProjectSummary(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '项目',
        path: json['path'] as String? ?? '',
      );
}

class ChangedFile {
  const ChangedFile({
    required this.path,
    required this.status,
    this.additions,
    this.deletions,
  });

  final String path;
  final String status;
  final int? additions;
  final int? deletions;

  factory ChangedFile.fromJson(Map<String, dynamic> json) => ChangedFile(
        path: json['path'] as String? ?? '',
        status: json['status'] as String? ?? '?',
        additions: (json['additions'] as num?)?.toInt(),
        deletions: (json['deletions'] as num?)?.toInt(),
      );
}

class TurnChanges {
  const TurnChanges({
    required this.changeId,
    required this.files,
    this.messageId = '',
    this.turnIndex = 0,
    this.createdAt = 0,
    this.brief,
    this.treeAvailable = false,
  });

  final String changeId;
  final List<ChangedFile> files;
  final String messageId;
  final int turnIndex;
  final int createdAt;
  final String? brief;
  final bool treeAvailable;

  factory TurnChanges.fromJson(Map<String, dynamic> json) => TurnChanges(
        changeId: json['changeId'] as String? ?? '',
        messageId: json['messageId'] as String? ?? '',
        turnIndex: (json['turnIndex'] as num?)?.toInt() ?? 0,
        createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
        brief: json['brief'] as String?,
        treeAvailable: json['treesAvailable'] == true,
        files: (json['files'] as List?)
                ?.whereType<Map>()
                .map((e) => ChangedFile.fromJson(Map<String, dynamic>.from(e)))
                .toList() ??
            const [],
      );
}

class ChangeDiff {
  const ChangeDiff({
    required this.path,
    required this.status,
    required this.patch,
    this.truncated = false,
    this.supported = true,
  });

  final String path;
  final String status;
  final String patch;
  final bool truncated;
  final bool supported;
}

class PendingAttachment {
  const PendingAttachment({
    required this.id,
    required this.name,
    required this.bytes,
    this.uploading = false,
  });

  final String id;
  final String name;
  final int bytes;
  final bool uploading;
}

class WorkspaceEntry {
  const WorkspaceEntry({required this.name, required this.type, this.size = 0});

  final String name;
  final String type;
  final int size;

  bool get isDir => type == 'dir';

  factory WorkspaceEntry.fromJson(Map<String, dynamic> json) => WorkspaceEntry(
        name: json['name'] as String? ?? '',
        type: json['type'] as String? ?? 'file',
        size: (json['size'] as num?)?.toInt() ?? 0,
      );
}

class WorkspaceFile {
  const WorkspaceFile({
    required this.path,
    required this.text,
    this.size = 0,
    this.truncated = false,
    this.encoding = 'utf8',
  });

  final String path;
  final String text;
  final int size;
  final bool truncated;
  final String encoding;
}

