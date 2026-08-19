import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// 1. 收集所有 ctx.provide 注册的服务名
const providerDir = 'src/core/provider'
const providedServices = []

function scanProvider(filePath) {
  const content = readFileSync(filePath, 'utf8')
  // 匹配 ctx.provide('serviceName' 和 ctx.provide("serviceName"
  const matches = [...content.matchAll(/ctx\.provide\(\s*['"]([^'"]+)['"]/g)]
  matches.forEach(m => providedServices.push({ file: filePath, service: m[1] }))
}

function scanDir(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      scanDir(fullPath)
    } else if (entry.name.endsWith('.ts')) {
      scanProvider(fullPath)
    }
  }
}

scanDir(providerDir)

// 2. 收集所有 ctx.get('serviceName') 或 getCtxService('serviceName') 的消费
const consumedServices = []

function scanConsumption(filePath) {
  const content = readFileSync(filePath, 'utf8')
  // ctx.get('xxx') 和 ctx.get("xxx")
  const m1 = [...content.matchAll(/ctx\.get\(\s*['"]([^'"]+)['"]/g)]
  m1.forEach(m => consumedServices.push({ file: filePath, service: m[1] }))
  // getCtxService('xxx')
  const m2 = [...content.matchAll(/getCtxService\(\s*['"]([^'"]+)['"]/g)]
  m2.forEach(m => consumedServices.push({ file: filePath, service: m[1] }))
}

// 扫描所有 src 下的 .ts 和 .tsx 文件
function scanAllSrc(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue
      scanAllSrc(fullPath)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      scanConsumption(fullPath)
    }
  }
}

scanAllSrc('src')

const providedNames = [...new Set(providedServices.map(s => s.service))]
const consumedNames = [...new Set(consumedServices.map(s => s.service))]

// 3. 交叉比对
const providedButNotConsumed = providedNames.filter(s => !consumedNames.includes(s))
const consumedButNotProvided = consumedNames.filter(s => !providedNames.includes(s))

console.log('=== 审计2: ctx.provide 注册 vs ctx.get 消费 ===\n')
console.log(`通过 ctx.provide 注册的服务: ${providedNames.length} 个`)
providedNames.forEach(s => console.log(`  📦 ${s}`))

console.log(`\n通过 ctx.get/getCtxService 消费的服务: ${consumedNames.length} 个`)
consumedNames.forEach(s => console.log(`  ✅ ${s}`))

console.log(`\n=== ⚠️ 注册了但从未被 ctx.get 消费的服务 (死服务) ===`)
providedButNotConsumed.forEach(s => {
  const providers = providedServices.filter(p => p.service === s)
  console.log(`  🔴 ${s}`)
  providers.forEach(p => console.log(`     └─ ${p.file}`))
})

console.log(`\n=== ⚠️ 被消费但从未被 ctx.provide 注册的服务 (必然返回 null) ===`)
consumedButNotProvided.forEach(s => {
  const consumers = consumedServices.filter(c => c.service === s)
  console.log(`  ❌ ${s}`)
  consumers.forEach(c => console.log(`     └─ ${c.file}`))
})
