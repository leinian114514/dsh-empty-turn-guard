/**
 * dsh-empty-turn-guard —— 接住「模型空转」。
 *
 * ## 它治什么
 *
 * 一个回合里模型只输出了思考（thinking），正文一个字没有、工具一个没调，
 * 界面却显示「已完成」。用户看到的是"AI 想了一下就说做完了，其实啥也没干"。
 *
 * ## 为什么 DSH 自己没兜住（本插件存在的理由）
 *
 * DSH 有 `EMPTY_RESPONSE` 错误码，也在默认重试列表里，但它的判据是
 * 「a terminal `stop` with **no content blocks**」—— **一个内容块都没有**才算空。
 * 而空转的消息里**有 reasoning 块**，在它眼里叫"有内容"，于是静默通过。
 * 本插件补的就是这一格。
 *
 * ## 怎么发现（关键实现选择）
 *
 * 一开始想用 `assistant/message` + `agent.ctx` 的 per-agent 注册，实测在**插件根上下文上
 * 收不到这个事件**（诊断日志里挂上了却一条没触发）。真正能用的是
 * **`agent/assistant-stream`**：它的 payload 带 `agent`，frame 有 `start` / `chunk`，
 * chunk 分 `reasoning-delta` / `text-delta` / `tool-call-delta` 三种 —— 一次就能分清
 * "想了 / 写了 / 做了"。参照本机已在跑的 `dsh-thinking-guard`（它用同一个钩子且工作正常）。
 *
 * 每次 `start` 代表一次新的 attempt（一个回合可能有多个 step），所以在 start 时重置、
 * 只保留**最后一次尝试**的内容 —— 这正是"最后一条 assistant 消息"的等价物，
 * 也正是空转判据该看的那一条。
 *
 * ## 重试策略（用户 2026-11-19 拍板）
 *
 * 自动重试**一次**；第二次还空就把控制权还给用户，不无声烧轮次。
 * 连续撞到上限就停手，绝不无限催。
 */

export const name = 'dsh-empty-turn-guard'

// 不需要额外服务：监听的是 agent 生命周期事件，动作只用 agent 自己的方法。
export const inject = []

import fs from 'node:fs'

export function apply(ctx, config) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const maxConsecutive = num(config?.maxConsecutive, 3)
  // 🛑 2026-11-19 审计后定稿：门槛**默认 0**，也就是「只要有思考、没正文、没工具就催」。
  //    经过：原来设 40，真机上一次思考 39 字的空转被放过；改成 10，审计指出
  //    「思考 <10 字 + 无正文 + 无工具」这一格**两边都不兜** ——
  //    插件不催，DSH 自己的 EMPTY_RESPONSE 判据是 `content.length === 0`（reasoning 算内容）
  //    也不重试，于是 100% 漏掉。而正常回合一定有正文或工具调用，
  //    "两样都没有"本身就是异常，跟思考了多久无关。
  //    ⇒ 门槛只保留「reasoning 不能为空」这一个下限，不再拿字数区分。
  const minReasoningChars = num(config?.minReasoningChars, 0)

  // 为什么写文件：`ctx.logger` 的输出在桌面版里不一定看得到（不进 web.log），
  // 而"插件装了但没在工作"是这类守卫插件最容易翻车的形态 —— 必须留下可核查的痕迹。
  // 为什么不写死路径：交到别人机器上 `appendFileSync` 会抛 ENOENT 被吞掉，
  // 守卫就变成哑巴且不留任何痕迹。默认空 = 只用 ctx.logger（桌面版看不到，但不崩）。
  const debugFile = typeof config?.debugFile === 'string' ? config.debugFile : ''
  const dbg = (line) => {
    if (!debugFile) return
    try { fs.appendFileSync(debugFile, `${new Date().toISOString()} ${line}\n`) } catch { /* 写不了就算了 */ }
  }
  const log = (m) => { ctx.logger?.info?.(`[empty-turn-guard] ${m}`); dbg(`INFO ${m}`) }
  const warn = (m) => { ctx.logger?.warn?.(`[empty-turn-guard] ${m}`); dbg(`WARN ${m}`) }

  /** 每个 agent 的当前 attempt 累积 + 跨回合的连续计数。 */
  const states = new Map()
  const stateOf = (key) => {
    let s = states.get(key)
    if (!s) {
      s = {
        cur: { reasoning: '', text: '', toolCall: 0 },
        consecutive: 0,
      }
      states.set(key, s)
    }
    return s
  }

  const resetAttempt = (s) => {
    s.cur = { reasoning: '', text: '', toolCall: 0 }
  }

  // ── 累积流式输出：分清"想了 / 写了 / 做了" ──────────────────────────
  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const agent = payload?.agent
      if (!agent || !agent.id) return
      const frame = payload?.frame
      if (!frame || typeof frame !== 'object') return
      const s = stateOf(agent.id)
      if (frame.type === 'start') {
        resetAttempt(s)
        return
      }
      if (frame.type !== 'chunk') return
      const c = frame.chunk
      if (!c || typeof c !== 'object') return
      const delta = typeof c.text === 'string'
        ? c.text
        : typeof c.delta === 'string'
          ? c.delta
          : ''
      if (c.type === 'reasoning-delta') {
        if (delta) s.cur.reasoning += delta
      } else if (c.type === 'text-delta') {
        if (delta) s.cur.text += delta
      } else if (c.type === 'tool-call-delta') {
        s.cur.toolCall += 1
      }
    } catch (e) {
      warn(`assistant-stream 处理出错：${e && e.message}`)
    }
  })

  /** 把一段提示交给 agent，让它再跑一步（这是唯一会"唤醒"它的方式）。 */
  function nudge(agent, text) {
    try {
      if (typeof agent.followup !== 'function') return false
      agent.followup({
        id: `etg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin:dsh-empty-turn-guard',
          form: 'snapshot',
          sections: [{ name: 'empty turn guard', text }],
        },
      })
      return true
    } catch (e) {
      warn(`followup 失败：${e && e.message}`)
      return false
    }
  }

  // ── 回合收尾时判断 ──────────────────────────────────────────────
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload?.agent
      if (!agent || !agent.id) return
      const s = stateOf(agent.id)
      const c = s.cur

      const hasReasoning = c.reasoning.trim().length > minReasoningChars
      const hasText = c.text.trim() !== ''
      const hasTool = c.toolCall > 0

      // 正常回合：清掉连续计数（空转只有连续发生才有意义）
      if (hasText || hasTool) {
        s.consecutive = 0
        // 每轮都留一行 —— 没有这行就分不清"没空转"和"插件根本没在跑"。
        dbg(`INFO turn-stopping 正常：思考 ${c.reasoning.length} 字 / 正文 ${c.text.length} 字 / 工具 ${c.toolCall} 次`)
        resetAttempt(s)
        return
      }

      // 连思考都没有 ⇒ 那是 DSH 自己的 EMPTY_RESPONSE 该管的范围（它判 content.length === 0，
      // 会重试）。这里不插手，只记一条便于排查。
      if (!hasReasoning) {
        // 🛑 审计修（P1）：这个分支原来**不清零** consecutive，
        //    于是「空转1（催）→ 一个思考极短的空回合 → 真空转」会被吃掉一次催的机会。
        //    它也算一个"没干活的回合"，跟正常回合一样该把连续计数归零。
        s.consecutive = 0
        log(
          `最后一步无正文/无工具，且思考为空（${c.reasoning.length} 字），交给 DSH 的 EMPTY_RESPONSE 处理。`
        )
        resetAttempt(s)
        return
      }

      s.consecutive += 1
      const info =
        `agent=${String(agent.id).slice(-12)} 连续第 ${s.consecutive} 次` +
        `（思考 ${c.reasoning.length} 字 / 正文 ${c.text.length} 字 / 工具 0 次）`

      if (s.consecutive >= maxConsecutive) {
        warn(`空转已达连续上限 ${maxConsecutive} 次，停止自动重试。${info}`)
        resetAttempt(s)
        return
      }

      // 只催**第一次**。第二次还空说明它是真卡住了，再催就是白烧 token ——
      // 把控制权还给用户，而不是在后台一直转。
      if (s.consecutive > 1) {
        log(`第 ${s.consecutive} 次空转，不再自动重试（把控制权交回用户）。${info}`)
        resetAttempt(s)
        return
      }

      const text =
        '🛑 你上一轮**只输出了思考**：正文是空的，也没有调用任何工具，' +
        '但界面把它显示成了「已完成」。\n' +
        '也就是说，你想到的东西一样都没落地。\n' +
        '\n' +
        '现在请把刚才想的那件事**真正做出来**：该改文件就改、该跑命令就跑、' +
        '该给结论就直接写正文。不要再只思考。'
      if (nudge(agent, text)) {
        log(`检测到空转，已让它重做。${info}`)
      } else {
        warn(`检测到空转，但发不出 followup（agent 没有该方法或调用失败）。${info}`)
      }
      resetAttempt(s)
    } catch (e) {
      warn(`turn-stopping 处理出错：${e && e.message}`)
    }
  })

  ctx.effect(() => () => { states.clear() })

  log(
    `已启用（只催第一次 / 连续上限 ${maxConsecutive} 次 / ` +
      `思考门槛 ${minReasoningChars} 字）。判据：有 reasoning、无 text、无 tool-call。`
  )
}
