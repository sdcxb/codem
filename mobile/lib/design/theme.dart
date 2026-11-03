import 'package:flutter/material.dart';

import 'tokens.dart';

/// 桌面同源的品牌字体（子集化前先打包，后续用 font-subset 处理体积）。
const String kCodemSans = 'CodemSans';
const String kCodemMono = 'CodemMono';

ThemeData _base(CodemPalette palette, Brightness brightness) {
  final base = ThemeData(
    useMaterial3: true,
    brightness: brightness,
    scaffoldBackgroundColor: palette.canvas,
    canvasColor: palette.canvas,
    fontFamily: kCodemSans,
    splashFactory: InkSparkle.splashFactory,
    visualDensity: VisualDensity.standard,
    materialTapTargetSize: MaterialTapTargetSize.padded,
    colorScheme: ColorScheme(
      brightness: brightness,
      primary: palette.accent,
      onPrimary: Colors.white,
      secondary: palette.accent,
      onSecondary: Colors.white,
      error: palette.danger,
      onError: Colors.white,
      surface: palette.surface,
      onSurface: palette.textPrimary,
    ),
    dividerColor: palette.hairline,
    extensions: <ThemeExtension<dynamic>>[palette],
  );

  final textTheme = TextTheme(
    displaySmall: TextStyle(
      fontFamily: kCodemSans,
      fontSize: 32,
      height: 1.18,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.6,
      color: palette.textPrimary,
    ),
    headlineSmall: TextStyle(
      fontFamily: kCodemSans,
      fontSize: 24,
      height: 1.25,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.4,
      color: palette.textPrimary,
    ),
    titleMedium: TextStyle(
      fontFamily: kCodemSans,
      fontSize: 17,
      height: 1.35,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.2,
      color: palette.textPrimary,
    ),
    bodyLarge: TextStyle(
      fontFamily: kCodemSans,
      fontSize: 16,
      height: 1.6,
      fontWeight: FontWeight.w400,
      color: palette.textPrimary,
    ),
    bodyMedium: TextStyle(
      fontFamily: kCodemSans,
      fontSize: 15,
      height: 1.55,
      fontWeight: FontWeight.w400,
      color: palette.textPrimary,
    ),
    bodySmall: TextStyle(
      fontFamily: kCodemSans,
      fontSize: 13,
      height: 1.45,
      fontWeight: FontWeight.w400,
      color: palette.textSecondary,
    ),
    labelLarge: TextStyle(
      fontFamily: kCodemSans,
      fontSize: 15,
      height: 1.2,
      fontWeight: FontWeight.w600,
      color: palette.textPrimary,
    ),
    labelMedium: TextStyle(
      fontFamily: kCodemSans,
      fontSize: 13,
      height: 1.2,
      fontWeight: FontWeight.w500,
      color: palette.textSecondary,
    ),
    labelSmall: TextStyle(
      fontFamily: kCodemSans,
      fontSize: 12,
      height: 1.3,
      fontWeight: FontWeight.w400,
      letterSpacing: 0.1,
      color: palette.textSecondary,
    ),
  );

  return base.copyWith(
    textTheme: textTheme,
    primaryTextTheme: textTheme,
    appBarTheme: AppBarTheme(
      backgroundColor: palette.canvas,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: textTheme.titleMedium,
      iconTheme: IconThemeData(color: palette.textPrimary, size: CodemSize.iconLarge),
    ),
    iconTheme: IconThemeData(color: palette.textSecondary, size: CodemSize.icon),
    dividerTheme: DividerThemeData(color: palette.hairline, thickness: 1, space: 1),
    cardTheme: CardThemeData(
      color: palette.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(CodemRadius.md),
        side: BorderSide(color: palette.hairline),
      ),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: palette.surface,
      surfaceTintColor: Colors.transparent,
      modalBackgroundColor: palette.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(CodemRadius.sheet)),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: palette.surfaceRaised,
      contentTextStyle: textTheme.bodyMedium,
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(CodemRadius.sm)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: palette.surface,
      hintStyle: textTheme.bodyMedium?.copyWith(color: palette.textSecondary),
      contentPadding: const EdgeInsets.symmetric(horizontal: CodemSpace.md, vertical: CodemSpace.md),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(CodemRadius.input),
        borderSide: BorderSide(color: palette.hairline),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(CodemRadius.input),
        borderSide: BorderSide(color: palette.hairline),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(CodemRadius.input),
        borderSide: BorderSide(color: palette.accent, width: 1.2),
      ),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected) ? Colors.white : palette.textSecondary,
      ),
      trackColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected) ? palette.accent : palette.surfaceRaised,
      ),
      trackOutlineColor: WidgetStatePropertyAll(palette.hairline),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: palette.accent),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: palette.accent,
      selectionColor: palette.accent.withValues(alpha: 0.28),
      selectionHandleColor: palette.accent,
    ),
    extensions: <ThemeExtension<dynamic>>[palette],
  );
}

abstract final class CodemTheme {
  static ThemeData dark() => _base(CodemPalette.dark, Brightness.dark);
  static ThemeData light() => _base(CodemPalette.light, Brightness.light);
}

extension CodemThemeX on BuildContext {
  CodemPalette get palette => Theme.of(this).extension<CodemPalette>()!;
  TextTheme get texts => Theme.of(this).textTheme;
}
