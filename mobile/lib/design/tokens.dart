import 'package:flutter/material.dart';

/// Codem Mobile design tokens.
///
/// 颜色/间距/圆角/字号全部从这里取；组件里不允许出现写死的色值。
/// 数值来自桌面 `src/styles.css` 的同一套品牌语言，移动端只做可读性校准
/// （正文 16sp、点击区 44、行高 72）。
@immutable
class CodemPalette extends ThemeExtension<CodemPalette> {
  const CodemPalette({
    required this.canvas,
    required this.surface,
    required this.surfaceRaised,
    required this.hairline,
    required this.textPrimary,
    required this.textSecondary,
    required this.accent,
    required this.accentPressed,
    required this.userBubble,
    required this.codeBg,
    required this.success,
    required this.warning,
    required this.danger,
  });

  final Color canvas;
  final Color surface;
  final Color surfaceRaised;
  final Color hairline;
  final Color textPrimary;
  final Color textSecondary;
  final Color accent;
  final Color accentPressed;
  final Color userBubble;
  final Color codeBg;
  final Color success;
  final Color warning;
  final Color danger;

  static const dark = CodemPalette(
    canvas: Color(0xFF0F1217),
    surface: Color(0xFF1A1D23),
    surfaceRaised: Color(0xFF20242C),
    hairline: Color(0x14FFFFFF),
    textPrimary: Color(0xFFE8E8EC),
    textSecondary: Color(0xFF9A9AA3),
    accent: Color(0xFF7C6CF0),
    accentPressed: Color(0xFF6555E0),
    userBubble: Color(0x1A7C6CF0),
    codeBg: Color(0xFF0B0D11),
    success: Color(0xFF4ADE80),
    warning: Color(0xFFF5C26B),
    danger: Color(0xFFF87171),
  );

  static const light = CodemPalette(
    canvas: Color(0xFFFAFAF9),
    surface: Color(0xFFFFFFFF),
    surfaceRaised: Color(0xFFF4F4F2),
    hairline: Color(0xFFE7E5E4),
    textPrimary: Color(0xFF1A1A1A),
    textSecondary: Color(0xFF6B6B6B),
    accent: Color(0xFF6555E0),
    accentPressed: Color(0xFF5546C8),
    userBubble: Color(0xFFF1EFFE),
    codeBg: Color(0xFFF6F6F4),
    success: Color(0xFF16A34A),
    warning: Color(0xFFB45309),
    danger: Color(0xFFDC2626),
  );

  @override
  CodemPalette copyWith({
    Color? canvas,
    Color? surface,
    Color? surfaceRaised,
    Color? hairline,
    Color? textPrimary,
    Color? textSecondary,
    Color? accent,
    Color? accentPressed,
    Color? userBubble,
    Color? codeBg,
    Color? success,
    Color? warning,
    Color? danger,
  }) {
    return CodemPalette(
      canvas: canvas ?? this.canvas,
      surface: surface ?? this.surface,
      surfaceRaised: surfaceRaised ?? this.surfaceRaised,
      hairline: hairline ?? this.hairline,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      accent: accent ?? this.accent,
      accentPressed: accentPressed ?? this.accentPressed,
      userBubble: userBubble ?? this.userBubble,
      codeBg: codeBg ?? this.codeBg,
      success: success ?? this.success,
      warning: warning ?? this.warning,
      danger: danger ?? this.danger,
    );
  }

  @override
  CodemPalette lerp(ThemeExtension<CodemPalette>? other, double t) {
    if (other is! CodemPalette) return this;
    Color mix(Color a, Color b) => Color.lerp(a, b, t) ?? a;
    return CodemPalette(
      canvas: mix(canvas, other.canvas),
      surface: mix(surface, other.surface),
      surfaceRaised: mix(surfaceRaised, other.surfaceRaised),
      hairline: mix(hairline, other.hairline),
      textPrimary: mix(textPrimary, other.textPrimary),
      textSecondary: mix(textSecondary, other.textSecondary),
      accent: mix(accent, other.accent),
      accentPressed: mix(accentPressed, other.accentPressed),
      userBubble: mix(userBubble, other.userBubble),
      codeBg: mix(codeBg, other.codeBg),
      success: mix(success, other.success),
      warning: mix(warning, other.warning),
      danger: mix(danger, other.danger),
    );
  }
}

/// 4/8 栅格；不要随手写 magic number。
abstract final class CodemSpace {
  static const xs = 4.0;
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 24.0;
  static const xxl = 32.0;
}

abstract final class CodemRadius {
  static const sm = 10.0;
  static const md = 14.0;
  static const input = 16.0;
  static const sheet = 24.0;
  static const full = 999.0;
}

abstract final class CodemSize {
  /// 最小触控区（Android 48dp / iOS 44pt 取更严的一档）
  static const touch = 48.0;
  static const button = 48.0;
  static const row = 72.0;
  static const icon = 20.0;
  static const iconLarge = 22.0;
  static const maxReading = 680.0;
}

abstract final class CodemDuration {
  static const fast = Duration(milliseconds: 150);
  static const normal = Duration(milliseconds: 220);
  static const sheet = Duration(milliseconds: 240);
}
