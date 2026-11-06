plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "io.codem.codem_mobile"
    compileSdk = flutter.compileSdkVersion
    // 显式钉住 Flutter 期望的 NDK 版本（上游模板同样写 `flutter.ndkVersion`）。
    // 本项目自己**没有** C/C++ 源码，但 Flutter 3.4x 的 Gradle 插件会为 native assets
    // 配置一个合成 CMake 工程：ndkVersion 不设且 NDK 不在安装列表时它会强制走 CMake，
    // 而本机 NDK 缺失/被裁剪时构建会直接失败。钉住版本后由 Flutter 工具做 NDK 供给。
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packagingOptions {
        jniLibs {
            // 调试包不做 native 符号裁剪：本机没有完整 NDK 时 llvm-strip 不存在。
            keepDebugSymbols += "**/*.so"
            // 本机 Host 的可执行文件（proot / proot_loader / codem_db / node）以
            // `lib/<abi>/lib*.so` 形式随包；**必须**让系统在安装时把它们解出到
            // nativeLibraryDir（可执行位由系统给），否则 PRoot/Node 无法 exec。
            useLegacyPackaging = true
        }
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "io.codem.codem_mobile"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = maxOf(flutter.minSdkVersion, 26)
        // ⚠️ 硬约束：PRoot 依赖「应用数据目录 exec」+「ptrace 子进程」，Android 10+ 对
        // targetSdk≥29 的应用一律禁止这两件事。改成 29+ 会让本机 Host 直接起不来。
        // 代价：不能上架 Google Play（本项目 sideload）。
        // 排查插件兼容性时可以临时改这里，但要同步记录到
        // mobile/android/LOCAL_HOST_CONTRACT_ADDENDUM.md 的「已知风险」。
        targetSdk = 28
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    lint {
        // targetSdk=28 是 PRoot 的硬约束（exec/ptrace），不面向 Play；不要让 Play 目标版本规则阻断 sideload 构建。
        abortOnError = false
        checkReleaseBuilds = false
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
