/**
 * 空转守卫的逻辑验证（不依赖运行时，纯模拟事件）。
 *
 * 为什么要它：这类"守卫"插件最典型的翻车是**装了但根本没在工作** ——
 * 判据写反、钩子名错、字段读错，外面看起来一切正常。所以必须能证明：
 *   ① 只有思考的回合 → 会催
 *   ② 有正文的回合 → 不催
 *   ③ 调了工具的回合 → 不催
 *   ④ 思考太短（寒暄）→ 不催
 *   ⑤ 第二次连续空转 → 不再催（把控制权还回去）
 *   ⑥ 超过连续上限 → 也不再催
 *   ⑦ 多 step 的回合：最后一步有产出就不算空转（只看最后一次 attempt）
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "<DSH.exe>" test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from './index.js'

// 🛑 2026-11-19 审计修（P0）：配置必须从 `cordis.patch.yml` **真读**，不能硬编码。
//    原来这里写死 `minReasoningChars: 10`，覆盖了 index.js 的默认值，
//    结果把默认值改回真机上漏判的那个 40，11 例照样全绿 —— 核心修复零回归保护。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const yml = fs.readFileSync(path.join(HERE, 'cordis.patch.yml'), 'utf8')
const pick = (key, dflt) => {
  const m = yml.match(new RegExp(`^\\s*${key}:\\s*(-?[0-9.]+)\\s*$`, 'm'))
  return m ? Number(m[1]) : dflt
}
const CFG_MIN = pick('minReasoningChars', 0)
const CFG_MAXCONS = pick('maxConsecutive', 3)
console.log(`（配置来自 cordis.patch.yml：minReasoningChars=${CFG_MIN}, maxConsecutive=${CFG_MAXCONS}）`)

let pass = 0
let fail = 0
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`✅ ${label}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`❌ ${label}${extra ? '  ' + extra : ''}`) }
}

const handlers = {}
const ctx = {
  on: (ev, fn) => { handlers[ev] = fn },
  logger: { info: () => {}, warn: () => {} },
  effect: (fn) => { try { fn() } catch {} },
}
apply(ctx, { minReasoningChars: CFG_MIN, maxConsecutive: CFG_MAXCONS })

check('配置门槛必须是 0（真机上漏判过 39 字，再设门槛就会重犯）', CFG_MIN === 0, `实际 ${CFG_MIN}`)

check('钩子都挂上了', !!handlers['agent/assistant-stream'] && !!handlers['agent/turn-stopping'],
  Object.keys(handlers).join(','))

let nudges = []
const mkAgent = (id) => ({
  id,
  followup: (m) => {
    const t = (m.content || []).map((b) => b.text || '').join('')
    nudges.push({ id, text: t })
  },
})
const stream = (agent, frame) => handlers['agent/assistant-stream']({ agent, frame })
const start = (agent) => stream(agent, { type: 'start' })
const think = (agent, text) => stream(agent, { type: 'chunk', chunk: { type: 'reasoning-delta', text } })
const say = (agent, text) => stream(agent, { type: 'chunk', chunk: { type: 'text-delta', text } })
const tool = (agent) => stream(agent, { type: 'chunk', chunk: { type: 'tool-call-delta', text: 'x' } })
const endTurn = (agent) => handlers['agent/turn-stopping']({ agent })

// ① 纯思考 → 催
{
  const a = mkAgent('a1')
  nudges = []
  start(a)
  think(a, '我打算先看一下那个文件，然后再改掉里面的判断逻辑，最后跑一遍测试确认没弄坏别的。')
  endTurn(a)
  check('① 只有思考 → 会催它重做', nudges.length === 1)
  check('① 催的话里说清了「只输出了思考」', /只输出了思考/.test(nudges[0]?.text || ''))
}

// ② 有正文 → 不催
{
  const a = mkAgent('a2')
  nudges = []
  start(a)
  think(a, '我想了很多很多内容，但是最后我确实写出了正文并且交付了结果。')
  say(a, '已经改好了，测试也过了。')
  endTurn(a)
  check('② 有正文 → 不催', nudges.length === 0)
}

// ③ 调了工具 → 不催
{
  const a = mkAgent('a3')
  nudges = []
  start(a)
  think(a, '我先想想怎么做，然后去调用工具把它实现出来。')
  tool(a)
  endTurn(a)
  check('③ 调了工具 → 不催', nudges.length === 0)
}

// ④ 完全没有思考、也没有正文和工具 → 不催，交给 DSH 的 EMPTY_RESPONSE
//    （它判 content.length === 0，这种零内容块的情况它会重试）
{
  const a = mkAgent('a4')
  nudges = []
  start(a)
  endTurn(a)
  check('④ 零内容（连思考都没有）→ 不催，交给 DSH', nudges.length === 0)
}

// ④b ⚠️ 2026-11-19 真机漏判的回归：短思考 + 正文和工具都没有 → 必须催
//     原来门槛设 40，就因为差 1 个字放过去了一次真实的空转（真机日志：思考 39 字）。
//     现在门槛是 0，只要思考不为空就催。
{
  const a = mkAgent('a4b')
  nudges = []
  start(a)
  const short = '我看一下这个日志，先确认是哪一步出的问题。'
  think(a, short)
  endTurn(a)
  check('④b 短思考的真空转 → 必须催（不再被门槛放过）', nudges.length === 1, `思考 ${short.length} 字`)
}

// ④c 连 5 个字都要催：这一格 DSH 也不兜
//     （它的 EMPTY_RESPONSE 判 content.length === 0，reasoning 算内容 → 不会重试）
{
  const a = mkAgent('a4c')
  nudges = []
  start(a)
  think(a, '做吧。')
  endTurn(a)
  check('④c 只有 3 个字的思考也要催（DSH 那一格是空的）', nudges.length === 1)
}

// ⑤ 连续第二次空转 → 只记日志，不再催
{
  const a = mkAgent('a5')
  nudges = []
  const longThink = '我想了很久很久，规划了步骤但是一个字都没写出来，也没有调用任何工具去执行。'
  start(a); think(a, longThink); endTurn(a)
  start(a); think(a, longThink); endTurn(a)
  check('⑤ 连续第二次 → 不再催（交给用户）', nudges.length === 1, `实际 ${nudges.length} 次`)
}

// ⑥ 超过连续上限 → 停手
{
  const a = mkAgent('a6')
  nudges = []
  const longThink = '我又想了很久，还是只思考不产出，这样连续好几次了应该被停止自动重试。'
  for (let i = 0; i < 5; i++) { start(a); think(a, longThink); endTurn(a) }
  check('⑥ 连续超限 → 全程只催 1 次', nudges.length === 1, `实际 ${nudges.length} 次`)
}

// ⑦ 多 step：最后一步有产出 → 不算空转
{
  const a = mkAgent('a7')
  nudges = []
  start(a); think(a, '第一步我想想，先调工具拿数据。'); tool(a); endTurn(a)   // step1 有工具
  start(a); think(a, '拿到数据了，现在我来写结论。'); say(a, '结论是……'); endTurn(a) // step2 有正文
  check('⑦ 多 step、最后一步有产出 → 不催', nudges.length === 0)
}

// ⑦b 反方向：step1 有正文、step2 只有思考 → **必须催**（看的是最后一步）
//     🛑 审计补：原来只测了反方向，把 start 重置整段删掉测试也全绿。
{
  const a = mkAgent('a7b')
  nudges = []
  start(a); think(a, '先写点东西。'); say(a, '这是第一步的正文。'); endTurn(a)
  start(a); think(a, '接下来还得再改一处，但我又只想了想。'); endTurn(a)
  check('⑦b step1 有正文、step2 只有思考 → 必须催（只看最后一步）', nudges.length === 1, `实际 ${nudges.length} 次`)
}

// ⑧ 空转后重新有产出 → 连续计数归零（下回还能再催一次）
{
  const a = mkAgent('a8')
  nudges = []
  const longThink = '想一想，只想不做，真的什么都不产出，只有思考没有正文也没有工具调用。'
  start(a); think(a, longThink); endTurn(a)     // 空转 1 → 催
  start(a); say(a, '这次写了正文。'); endTurn(a)   // 正常 → 归零
  start(a); think(a, longThink); endTurn(a)     // 又空转 → 应该再催
  check('⑧ 中间恢复正常后，下次空转还能再催', nudges.length === 2, `实际 ${nudges.length} 次`)
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}  ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
