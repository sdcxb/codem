/*
 * 判据专用探针（**只在 `cargo test --lib` 里用**，不参与应用发布路径）。
 *
 * 作用：被 wrapper `.cmd` 当"目标 `.exe`"启动时，把**自己收到的 argv** 逐字节落盘。
 * 判据（`src/lib.rs` 的 `harden_186_tests`）拿它来问一个只有它能回答的问题：
 *
 *     经 wrapper 传过去的实参，到目标进程自己的 argv 里还是**逐字节**一样吗？
 *
 * ## 为什么不能只断言"我们拼出来的字符串"
 *
 * 那是判据与实现互相证明（假绿）。真正的两套解析规则是「cmd 的批处理解析」与
 * 「目标进程的 `CommandLineToArgvW`」，只有真起进程、读它自己的 argv 才算证据。
 *
 * ## 为什么单独一个 bin
 *
 * 试过"让测试二进制自己当目标"（在 `run()` 里自举探针）：**不行** ——
 * `cargo test` 生成的 `main` 是 libtest 的 harness，根本不走 `run()`；
 * 而 libtest 又会在看到 `--codem-argv-dump-186` 这种陌生选项时直接 exit(1)。
 * 所以单独立一个 bin：它自己有 `main`，且**不链接** libtest。
 *
 * 记录格式（与 lib.rs 的 `escape_argv_bytes` 同一口径）：
 *     argvN=<字节数>:<每个非 ASCII 可打印字节写成 \xNN 的文本>
 * 长度与内容都给 ⇒ "多一个不可见字符"也漏不掉。
 */
use std::io::Write;

/*
 * ⚠️ 这个常量必须与 `src/lib.rs` 的 `ARGV_DUMP_MAGIC` 一致 —— 判据
 * `r186_probe_source_and_lib_agree_on_the_magic` 会读这个源文件来钉住它。
 */
const ARGV_DUMP_MAGIC: &str = "--codem-argv-dump-186";

fn escape_bytes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if (0x20..0x7f).contains(b) && *b != b'\\' {
            out.push(*b as char);
        } else {
            out.push_str(&format!("\\x{:02X}", b));
        }
    }
    out
}

fn main() {
    let mut it = std::env::args_os();
    let _exe = it.next();
    if it.next().map(|a| a.to_string_lossy().to_string()).as_deref() != Some(ARGV_DUMP_MAGIC) {
        // 不是被当探针启动的：什么都不做（正常 `cargo run --bin` 也不会误写文件）。
        std::process::exit(0);
    }
    let out = match it.next() {
        Some(p) => p,
        None => std::process::exit(2),
    };
    let mut buf = Vec::new();
    for (i, a) in it.enumerate() {
        let s = a.to_string_lossy().to_string();
        buf.extend_from_slice(format!("argv{}={}:{}\n", i, s.len(), escape_bytes(&s)).as_bytes());
    }
    let mut f = std::fs::File::create(&out).expect("create argv dump");
    f.write_all(&buf).expect("write argv dump");
    f.flush().ok();
}
