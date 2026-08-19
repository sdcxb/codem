import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// 1. 收集所有被 SlotBridge/SlotListBridge 消费的 slot 名称
// 扫描所有 .tsx 和 .ts 文件中的 SlotBridge 使用
const consumedSlots = []
const consumeSources = []

function scanConsumeFile(filePath) {
  const content = readFileSync(filePath, 'utf8')
  // 匹配 <SlotBridge name="..." 和 <SlotListBridge name="..."
  const matches = [...content.matchAll(/(?:SlotBridge|SlotListBridge)\s+name=["']([^"']+)["']/g)]
  matches.forEach(m => {
    consumedSlots.push(m[1])
    consumeSources.push({ file: filePath, slot: m[1] })
  })
}

function scanConsumeDir(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      scanConsumeDir(fullPath)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      scanConsumeFile(fullPath)
    }
  }
}

// 扫描 App.tsx + components/ 中的所有消费
scanConsumeFile('src/App.tsx')
scanConsumeDir('src/components')
scanConsumeDir('src/core/ui-plugins')

const consumedSlotsSet = [...new Set(consumedSlots)]

// 2. 收集所有通过 slots.register 注册的 slot 名称
const providerDir = 'src/core/provider'
const uiPluginsDir = 'src/core/ui-plugins'
const slotRegistrations = []

function scanFile(filePath) {
  const content = readFileSync(filePath, 'utf8')
  const matches = [...content.matchAll(/slots\.register\(\s*\{\s*name:\s*['"]([^'"]+)['"]/g)]
  matches.forEach(m => slotRegistrations.push({ file: filePath, slot: m[1] }))
}

function scanDir(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      scanDir(fullPath)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      scanFile(fullPath)
    }
  }
}

scanDir(providerDir)
scanDir(uiPluginsDir)
scanFile('src/core/slots/declare-slots.ts')

const registeredSlots = [...new Set(slotRegistrations.map(r => r.slot))]

// 3. 交叉比对
const consumedButNotRegistered = consumedSlotsSet.filter(s => !registeredSlots.includes(s))
const registeredButNotConsumed = registeredSlots.filter(s => !consumedSlotsSet.includes(s))

console.log('=== 审计1: Slot 注册 vs 消费 ===\n')
console.log(`被 SlotBridge 消费的 slot: ${consumedSlotsSet.length} 个`)
consumedSlotsSet.forEach(s => {
  const sources = consumeSources.filter(c => c.slot === s)
  console.log(`  ✅ ${s} (${sources.length} 个消费点)`)
})

console.log(`\n通过 slots.register 注册的 slot: ${registeredSlots.length} 个`)
registeredSlots.forEach(s => {
  const consumers = slotRegistrations.filter(r => r.slot === s)
  console.log(`  📦 ${s} (${consumers.length} 个注册点)`)
})

console.log(`\n=== ⚠️ 被消费但未注册的 slot (将始终使用 fallback) ===`)
consumedButNotRegistered.forEach(s => console.log(`  ❌ ${s}`))

console.log(`\n=== ⚠️ 注册了但未被 SlotBridge 消费的 slot (注册了没用) ===`)
console.log(`总数: ${registeredButNotConsumed.length}`)
registeredButNotConsumed.forEach(s => {
  const consumers = slotRegistrations.filter(r => r.slot === s)
  console.log(`  🔴 ${s}`)
  consumers.forEach(c => console.log(`     └─ ${c.file}`))
})
