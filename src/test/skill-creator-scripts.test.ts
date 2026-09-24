/**
 * 第 97 轮：**内置 skill-creator 技能的 5 个 CLI 脚本从来没跑起来过** —— 这是实测发现并修掉的问题。
 *
 * 事实链（修改前）：
 *  - 5 个脚本的入口判定都是 CJS 写法 `if (require.main === module)`；
 *  - 仓库根 `package.json` 是 `"type": "module"` ⇒ ESM 作用域里 `require` 不存在；
 *  - 所以按脚本自己印的用法去跑，第一步就 `ReferenceError: require is not defined in ES module scope`；
 *    `package-skill.ts` 更直接：模块顶层无条件 `main()`，import 即执行。
 *
 * 修法：新增 `scripts/is-main.ts`（`isMainModule(import.meta.url)`），5 个脚本统一走它，
 * 兄弟 import 补 `.ts` 后缀（`allowImportingTsExtensions: true`，`node ≥22.18` 原生跑 TS 需要）。
 *
 * 本文件的价值有两层：
 *  1. 把 4 个此前 **0% 覆盖**的脚本拉到有覆盖（纯函数级：validateSkill / aggregateBenchmark /
 *     generateReviewHtml / loadEvals / validateSkillStructure / saveEvalMetadata…）；
 *  2. **CLI-1 直接 spawn 真进程**跑脚本 —— 这条才会抓到上面那个 bug（纯函数测试永远抓不到）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'

import { isMainModule } from '../core/skills/skill-creator/scripts/is-main.ts'
import { validateSkill } from '../core/skills/skill-creator/scripts/quick-validate.ts'
import {
  loadEvals,
  getEvalCase,
  validateSkillStructure,
  saveTiming,
  saveMetrics,
  saveEvalMetadata,
  packageSkill,
} from '../core/skills/skill-creator/scripts/run-eval.ts'
import {
  aggregateBenchmark,
  benchmarkToMarkdown,
} from '../core/skills/skill-creator/scripts/aggregate-benchmark.ts'
import { generateReviewHtml } from '../core/skills/skill-creator/scripts/generate-review.ts'

const ROOT = path.resolve(__dirname, '..', '..')
const SCRIPTS = path.join(ROOT, 'src', 'core', 'skills', 'skill-creator', 'scripts')
const NODE = process.versions.node
const NODE_MAJOR = Number(NODE.split('.')[0])
const NODE_MINOR = Number(NODE.split('.')[1])
/** `node x.ts` 原生跑 TS：Node ≥ 22.18（22 从 18 起默认开启 type stripping） */
const NATIVE_TS_OK = NODE_MAJOR > 22 || (NODE_MAJOR === 22 && NODE_MINOR >= 18)

let tmp: string

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

/** 一个"能通过校验"的技能目录（frontmatter 合法 + 有正文 + 有 scripts/references） */
function makeValidSkill(dir: string, name = 'demo-skill') {
  write(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'description: A demo skill used by the skill-creator script tests to check validation.',
      'version: 1.0.0',
      '---',
      '',
      '# Demo',
      '',
      'Do the thing.',
      '',
    ].join('\n'),
  )
  write(path.join(dir, 'scripts', 'helper.ts'), 'export const x = 1;\n')
  write(path.join(dir, 'references', 'schemas.md'), '# Schemas\n')
  write(path.join(dir, 'node_modules', 'ignored.js'), 'should not be packaged\n')
  write(path.join(dir, '.git', 'config'), 'should not be packaged\n')
}

function makeEvals(skillDir: string) {
  write(
    path.join(skillDir, 'evals', 'evals.json'),
    JSON.stringify(
      {
        skill_name: 'demo-skill',
        evals: [
          { id: 1, prompt: 'Do the first thing', expectations: ['output exists', 'no errors'] },
          { id: 2, prompt: 'Do the second thing', expectations: ['output exists'] },
        ],
      },
      null,
      2,
    ),
  )
}

/** 一个 benchmark 能聚合出来的 iteration 目录（with_skill / without_skill 各一份） */
function makeIteration(dir: string) {
  const evalDir = path.join(dir, 'eval-1')
  write(
    path.join(evalDir, 'eval_metadata.json'),
    JSON.stringify({ eval_id: 1, eval_name: 'eval-1', prompt: 'Do the first thing', assertions: ['output exists'] }, null, 2),
  )
  write(
    path.join(evalDir, 'with_skill', 'grading.json'),
    JSON.stringify(
      {
        summary: { pass_rate: 1, passed: 2, failed: 0, total: 2 },
        expectations: [{ text: 'output exists', passed: true, evidence: 'file found' }],
      },
      null,
      2,
    ),
  )
  write(
    path.join(evalDir, 'with_skill', 'timing.json'),
    JSON.stringify({ total_tokens: 1200, duration_ms: 3000, total_duration_seconds: 3 }, null, 2),
  )
  write(path.join(evalDir, 'with_skill', 'outputs', 'out.md'), 'with skill output\n')
  write(
    path.join(evalDir, 'without_skill', 'grading.json'),
    JSON.stringify(
      {
        summary: { pass_rate: 0.5, passed: 1, failed: 1, total: 2 },
        expectations: [{ text: 'output exists', passed: true, evidence: 'file found' }],
      },
      null,
      2,
    ),
  )
  write(
    path.join(evalDir, 'without_skill', 'timing.json'),
    JSON.stringify({ total_tokens: 800, duration_ms: 2000, total_duration_seconds: 2 }, null, 2),
  )
  write(path.join(evalDir, 'without_skill', 'outputs', 'out.md'), 'without skill output\n')
}

/** 把注释换成等长空格（保留偏移）：门禁不能把"说明文字里的反例"当成真反例 */
function stripComments(code: string): string {
  const out = code.split('')
  let quote: string | null = null
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] !== '\n') out[i] = ' '
        i++
      }
      if (i < code.length) { out[i] = ' '; out[i + 1] = ' '; i++ }
      continue
    }
  }
  return out.join('')
}

/** 真进程跑脚本：`node <script>.ts <args...>` */
function runCli(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
  })
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-creator-scripts-'))
})
afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
})

describe('skill-creator: is-main 入口判定（第 97 轮新增）', () => {
  const selfUrl = import.meta.url
  const selfPath = fileURLToPath(selfUrl)

  it('ISMAIN-1: 同一个文件 ⇒ true（本模块就是入口）', () => {
    expect(isMainModule(selfUrl, selfPath)).toBe(true)
  })

  it('ISMAIN-2: 别的文件 / 拿不到 argv[1] ⇒ false（被 import 时不执行 CLI）', () => {
    expect(isMainModule(selfUrl, path.join(ROOT, 'src', 'App.tsx'))).toBe(false)
    expect(isMainModule(selfUrl, undefined)).toBe(false)
    expect(isMainModule(selfUrl, '')).toBe(false)
  })

  it('ISMAIN-3: metaUrl 不是合法 file:// URL ⇒ false 且不抛（不把入口判定变成崩溃点）', () => {
    expect(() => isMainModule('not-a-url', selfPath)).not.toThrow()
    expect(isMainModule('not-a-url', selfPath)).toBe(false)
  })

  it('ISMAIN-4: Windows 路径大小写不敏感（C:\\ vs c:\\ 必须判为同一文件）', () => {
    const upper = selfPath.toUpperCase()
    expect(isMainModule(selfUrl, upper)).toBe(process.platform === 'win32')
    // 非 win32 时大小写不同就是不同文件，这是 POSIX 的正确语义
    if (process.platform !== 'win32') expect(isMainModule(selfUrl, selfPath.toLowerCase())).toBe(true)
  })
})

describe('skill-creator: quick-validate 校验逻辑', () => {
  it('QV-1: 合法技能目录 ⇒ valid，且读回了 name/description/资源布尔位', () => {
    const dir = path.join(tmp, 'skill-ok')
    makeValidSkill(dir)
    const result = validateSkill(dir)
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
    expect(result.info.name).toBe('demo-skill')
    expect(result.info.hasPrompt).toBe(true)
    expect(result.info.hasScripts).toBe(true)
    expect(result.info.hasReferences).toBe(true)
    expect(result.info.hasAssets).toBe(false)
    // SKILL.md 自己 + scripts/helper.ts + references/schemas.md
    expect(result.info.totalFiles).toBe(3)
  })

  it('QV-2: 缺 SKILL.md ⇒ 报错并直接返回（不继续读文件）', () => {
    const dir = path.join(tmp, 'skill-empty')
    fs.mkdirSync(dir, { recursive: true })
    const result = validateSkill(dir)
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('SKILL.md not found')
  })

  it('QV-3: frontmatter 缺 name/description、正文为空 ⇒ 逐条报错', () => {
    const dir = path.join(tmp, 'skill-bad')
    write(path.join(dir, 'SKILL.md'), '---\nversion: 1.0.0\n---\n')
    const result = validateSkill(dir)
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      "Frontmatter is missing 'name' field",
      "Frontmatter is missing 'description' field",
      'SKILL.md has empty body — prompt instructions are required',
    ])
  })

  it('QV-4: 非 kebab-case 名字 + 极短 description ⇒ 只是 warning，不算 invalid', () => {
    const dir = path.join(tmp, 'skill-warn')
    write(path.join(dir, 'SKILL.md'), '---\nname: Demo_Skill\ndescription: too short\n---\n\nBody here.\n')
    const result = validateSkill(dir)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings.join('\n')).toContain('not in kebab-case')
    expect(result.warnings.join('\n')).toContain('Description is very short')
  })
})

describe('skill-creator: run-eval 的读写辅助', () => {
  it('RE-1: loadEvals/getEvalCase 正常读；缺文件与未知 id 都抛可读错误', () => {
    const dir = path.join(tmp, 'skill-evals')
    makeValidSkill(dir)
    makeEvals(dir)
    expect(loadEvals(dir).evals).toHaveLength(2)
    expect(getEvalCase(dir, 2).prompt).toBe('Do the second thing')
    expect(() => getEvalCase(dir, 9)).toThrowError(/Eval ID 9 not found.*1, 2/s)
    const bare = path.join(tmp, 'skill-no-evals')
    makeValidSkill(bare)
    expect(() => loadEvals(bare)).toThrowError(/No evals\.json found/)
  })

  it('RE-2: validateSkillStructure —— 合法目录 [] ；缺 description 的 frontmatter 报错', () => {
    const ok = path.join(tmp, 'skill-struct-ok')
    makeValidSkill(ok)
    expect(validateSkillStructure(ok)).toEqual([])

    const bad = path.join(tmp, 'skill-struct-bad')
    fs.mkdirSync(bad, { recursive: true })
    write(path.join(bad, 'SKILL.md'), '---\nname: x\n---\n\nbody\n')
    const errors = validateSkillStructure(bad)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join('\n')).toContain('description')
  })

  it('RE-3: saveEvalMetadata / saveTiming / saveMetrics 落盘的字段就是下游读的字段', () => {
    const runDir = path.join(tmp, 'run-1')
    const outputsDir = path.join(runDir, 'outputs')
    fs.mkdirSync(outputsDir, { recursive: true })
    saveEvalMetadata(runDir, { id: 7, prompt: 'p', expectations: ['a', 'b'] } as any, 'eval-7')
    saveTiming(runDir, { total_tokens: 42, duration_ms: 1000, total_duration_seconds: 1 })
    saveMetrics(outputsDir, {
      tool_calls: { read: 2 },
      total_tool_calls: 2,
      total_steps: 3,
      files_created: ['a.md'],
      errors_encountered: 0,
    })
    const metadata = JSON.parse(fs.readFileSync(path.join(runDir, 'eval_metadata.json'), 'utf8'))
    expect(metadata).toEqual({ eval_id: 7, eval_name: 'eval-7', prompt: 'p', assertions: ['a', 'b'] })
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'timing.json'), 'utf8')).total_tokens).toBe(42)
    expect(JSON.parse(fs.readFileSync(path.join(outputsDir, 'metrics.json'), 'utf8')).total_steps).toBe(3)
  })

  it('RE-4: packageSkill 产出真 zip，且排除 node_modules / .git', async () => {
    const dir = path.join(tmp, 'skill-zip')
    makeValidSkill(dir)
    const zipPath = path.join(tmp, 'skill-zip.zip')
    await packageSkill(dir, zipPath)
    expect(fs.existsSync(zipPath)).toBe(true)
    const entries = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(zipPath))))
    expect(entries).toContain('SKILL.md')
    expect(entries).toContain('scripts/helper.ts')
    expect(entries.some(e => e.includes('node_modules'))).toBe(false)
    expect(entries.some(e => e.includes('.git'))).toBe(false)
  })
})

describe('skill-creator: benchmark 聚合与评审页', () => {
  it('AB-1: aggregateBenchmark 读出两组配置的通过率/耗时/token 与 delta 说明', () => {
    const dir = path.join(tmp, 'iteration-1')
    makeIteration(dir)
    const benchmark = aggregateBenchmark(dir, 'demo-skill')
    expect(benchmark.metadata.skill_name).toBe('demo-skill')
    expect(benchmark.metadata.evals_run).toEqual([1])
    expect(benchmark.runs.map((r: any) => r.configuration).sort()).toEqual(['with_skill', 'without_skill'])
    expect(benchmark.run_summary.with_skill.pass_rate.mean).toBe(1)
    expect(benchmark.run_summary.without_skill.pass_rate.mean).toBe(0.5)
    expect(benchmark.run_summary.with_skill.tokens.mean).toBe(1200)
    // 通过率 +50% ⇒ 正面说明；且那条断言两边都过 ⇒ 应该有"不区分"提示
    expect(benchmark.notes.join('\n')).toContain('improves pass rate by 50%')
    expect(benchmark.notes.join('\n')).toContain('may not discriminate skill value')
    const md = benchmarkToMarkdown(benchmark)
    expect(md).toContain('# Benchmark Report: demo-skill')
    expect(md).toContain('| Pass Rate |')
  })

  it('AB-2: 空目录不抛，产出 0 run 的 benchmark（避免聚合器自己成为崩溃点）', () => {
    const dir = path.join(tmp, 'iteration-empty')
    fs.mkdirSync(dir, { recursive: true })
    const benchmark = aggregateBenchmark(dir, 'demo-skill')
    expect(benchmark.runs).toEqual([])
    expect(benchmark.run_summary.with_skill.pass_rate.mean).toBe(0)
  })

  it('GR-1: generateReviewHtml 产出自包含 HTML，含技能名/eval 提示词/两侧输出', () => {
    const dir = path.join(tmp, 'iteration-review')
    makeIteration(dir)
    const benchmark = aggregateBenchmark(dir, 'demo-skill')
    const html = generateReviewHtml({
      skillName: 'demo-skill',
      iteration: 1,
      benchmark,
      evals: [
        {
          id: 1,
          name: 'eval-1',
          prompt: 'Do the first thing',
          withSkillOutput: 'with skill output',
          withoutSkillOutput: 'without skill output',
          grading: { summary: { pass_rate: 1 } },
        },
      ],
    } as any)
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('demo-skill')
    expect(html).toContain('Do the first thing')
    expect(html).toContain('with skill output')
    expect(html).toContain('</html>')
  })
})

describe('skill-creator: CLI 真进程 + 静态门禁', () => {
  it.skipIf(!NATIVE_TS_OK)('CLI-1: `node <script>.ts` 真能跑起来（旧写法在这里必崩 ReferenceError）', () => {
    const skillDir = path.join(tmp, 'skill-cli')
    makeValidSkill(skillDir)

    const validate = runCli('quick-validate.ts', [skillDir])
    expect(validate.status, `stderr=${validate.stderr}`).toBe(0)
    expect(validate.stdout).toContain('✅ Skill is valid')
    expect(validate.stderr).not.toContain('require is not defined')

    const zipPath = path.join(tmp, 'cli-skill.zip')
    const pack = runCli('package-skill.ts', [skillDir, zipPath])
    expect(pack.status, `stderr=${pack.stderr}`).toBe(0)
    expect(fs.existsSync(zipPath)).toBe(true)
    expect(fs.readFileSync(zipPath).subarray(0, 2).toString('latin1')).toBe('PK')

    // 没给参数时要印用法并 exit 1（而不是静默什么都不做）
    for (const script of ['run-eval.ts', 'quick-validate.ts', 'aggregate-benchmark.ts', 'generate-review.ts', 'package-skill.ts']) {
      const bare = runCli(script)
      expect(bare.status, script).toBe(1)
      expect(bare.stderr, script).toContain('Usage:')
      expect(bare.stderr, script).not.toContain('ReferenceError')
    }
  })

  it('CLI-2: 静态门禁 —— 全仓不再有 ESM 里必崩的 `require.main`，且 5 个脚本都走 isMainModule', () => {
    const srcFiles: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'test') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(entry.name)) srcFiles.push(full)
      }
    }
    walk(path.join(ROOT, 'src'))
    // 必须剥注释：本次修复的说明文字里**原样写着**这个反例（本测试第一版就是这样自己把自己报红的）
    const offenders = srcFiles
      .filter(f => /require\.main\s*===\s*module/.test(stripComments(fs.readFileSync(f, 'utf8'))))
      .map(f => path.relative(ROOT, f).replace(/\\/g, '/'))
    expect(offenders, '`require.main === module` 在 "type": "module" 下必然 ReferenceError').toEqual([])
    expect(srcFiles.length, '扫描器没扫到文件（门禁会静默通过）').toBeGreaterThan(200)

    const scripts = fs.readdirSync(SCRIPTS).filter(f => f.endsWith('.ts') && f !== 'is-main.ts')
    expect(scripts.length).toBeGreaterThanOrEqual(5)
    for (const script of scripts) {
      const code = fs.readFileSync(path.join(SCRIPTS, script), 'utf8')
      expect(code, `${script} 没有走 isMainModule 入口判定`).toContain('isMainModule(import.meta.url)')
      // 原生 node 跑 TS 要求相对 import 带扩展名
      const relativeImports = code.match(/from\s+"\.\/[^"]+"/g) ?? []
      for (const imp of relativeImports) {
        expect(imp, `${script} 的相对 import 缺 .ts 后缀（原生 node 跑不起来）`).toMatch(/\.ts"/)
      }
    }
  })

  it.skipIf(!NATIVE_TS_OK)('CLI-3: isMainModule 不是摆设 —— 被 import（而不是直接跑）时 CLI 体一行都不执行', () => {
    for (const script of ['run-eval.ts', 'quick-validate.ts', 'aggregate-benchmark.ts', 'generate-review.ts', 'package-skill.ts']) {
      const url = pathToFileURL(path.join(SCRIPTS, script)).href
      const imported = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`],
        { encoding: 'utf8', cwd: ROOT },
      )
      expect(imported.status, `${script} import 失败：${imported.stderr}`).toBe(0)
      expect(imported.stderr, `${script} 被 import 时印了 CLI 用法（= 入口判定失效）`).not.toContain('Usage:')
      expect(imported.stdout, `${script} 被 import 时产生了输出（= 有副作用）`).toBe('')
    }
  })
})
