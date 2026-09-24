/**
 * 第 98 轮门禁：**正则字符类里含 emoji（非 BMP）却没有 `u` 标志**。
 *
 * 这条判据来自一个真缺陷：`importer.ts` 剥笔记标题前缀时写了一个无 `u` 的字符类正则
 * （把 📝/📊 塞进方括号），于是"导入"把每条笔记标题都弄出一个孤立代理 ⇒ 界面显示「替换字符 U+FFFD + 空格 + 标题」。
 * 它**能过 tsc、能过 lint**，单测只要不覆盖那条路径也照样绿 —— 只有真的跑一遍导入才现形。
 *
 * 本文件用扫描器 `tools/audit/scan-regex-unicode.mjs`（逐文件找**真正的正则字面量**，
 * 跳过字符串/模板/注释）判两件事：
 *  1. 生产树里 0 处（REGEX-1）；
 *  2. 扫描器不是瞎的（REGEX-2/3：旧写法必须报、三种"像但不是"的写法不许报），
 *     并且**这个形态确实会造出替换字符 U+FFFD**（REGEX-4 直接复现）。
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { scanSource, scanTree } from '../../tools/audit/scan-regex-unicode.mjs'

const ROOT = path.resolve(__dirname, '..', '..')

describe('正则 Unicode 安全（第 98 轮新增）', () => {
  it('REGEX-1: 生产源码树里没有「非 BMP 字符类 + 无 u/v 标志」', () => {
    const { files, regexCount, classCount, findings } = scanTree(ROOT)
    // 扫描器自检：别因为"什么都没扫到"而恒绿
    expect(files, '扫描器没扫到文件').toBeGreaterThan(800)
    expect(regexCount, '扫描器没扫到正则字面量').toBeGreaterThan(800)
    expect(classCount, '扫描器没扫到字符类').toBeGreaterThan(200)
    expect(
      findings.map((f) => `${f.file}:${f.line} ${f.cp} ${f.regex}`),
      '字符类里的 emoji 在无 u 标志时按码元匹配 ⇒ 会留下孤立代理（渲染出来是 U+FFFD）',
    ).toEqual([])
  })

  it('REGEX-2: 反向对照 —— 修复前的那行写法必须被报出来', () => {
    const broken = "const title = line.replace(/^###\\s+/, '').replace(/^[📝📊]\\s*/, '').trim();\n"
    const fixed = "const title = line.replace(/^###\\s+/, '').replace(/^(?:📝|📊)\\s*/u, '').trim();\n"
    const bad = scanSource(broken, 'broken.ts')
    const good = scanSource(fixed, 'fixed.ts')
    expect(bad.findings).toHaveLength(1)
    expect(bad.findings[0].cls).toBe('[📝📊]')
    expect(bad.findings[0].ch).toBe('📝')
    expect(bad.findings[0].cp).toBe('U+1F4DD')
    expect(good.findings).toEqual([])
    // 带 v 标志（更严格的 Unicode 语义）同样算安全
    expect(scanSource("const r = /^[📝📊]\\s*/v\n", 'v.ts').findings).toEqual([])
  })

  it('REGEX-3: 三种"像但不是正则"的写法不许被误报', () => {
    const samples = [
      'const icons = ["⚡", "🤖", "🦊"]\n',                              // emoji 数组
      'const s = "标题 📝 与 📊 都在字符串里"\n',                        // 字符串里的 emoji
      'const t = `模板里的 📝 ${x} 也在字符串里`\n',                      // 模板字符串
      '// 注释里的 [📝📊] 不该被扫\nconst x = 1\n',                       // 注释
      'const n = a / b // 除号不是正则\n',                               // 除号
    ]
    for (const code of samples) {
      expect(scanSource(code, 'sample.ts').findings, code.trim()).toEqual([])
    }
  })

  it('REGEX-4: 这个形态真的会造出替换字符 U+FFFD—— 无 u 剥一半代理，有 u 不剥', () => {
    const titleLine = '📝 要点'
    const brokenTitle = titleLine.replace(/^[📝📊]\s*/, '')
    const fixedTitle = titleLine.replace(/^(?:📝|📊)\s*/u, '')
    // 无 u：只吃掉高位代理，留下孤立低位代理 ⇒ 渲染/落库就是 U+FFFD
    expect(brokenTitle).not.toBe(fixedTitle)
    expect([...brokenTitle][0].codePointAt(0)).toBeGreaterThanOrEqual(0xdc00)
    expect(fixedTitle).toBe('要点')
    // 用 UTF-8 往返看它到底成了什么（真机上界面显示的就是这个）
    expect(Buffer.from(brokenTitle, 'utf8').toString('utf8')).toContain('\uFFFD')
  })
})
