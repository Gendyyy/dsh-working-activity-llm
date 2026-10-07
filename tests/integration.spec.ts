/**
 * Full-loop integration: a scripted mock model drives the REAL working-activity
 * plugin through the agent loop. Only the model is mocked; the plugin, the
 * session log, and the append guard are real. This is the regression net for
 * the synchronous-append reentry bug: activity/status publishes deferred into a
 * microtask must land for every phase transition, including fast tools.
 *
 * 0.2.0-rc.2 host shape this suite is written against: `AgentLoop.create()`
 * returns a `Promise<Agent>` (so it is awaited), the agent is driven with
 * `agent.followup(...)`, and the durable log is read through
 * `agent.session.snapshotEvents()` (the old `session.events` field is gone).
 * A loop-built request also leaves `GenerateOptions.system` undefined — the
 * assembled system prompt rides the leading `system`-role message instead.
 * @module @deepseek-ai/dsh-working-activity/tests/integration
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as WorkingActivity from '../src/index'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter'
import { setLangOverride } from '../src/lang.ts'

// Deterministic language: the ambient machine may carry DSH_TUI_LANG or a
// persisted ~/.dsh-tui/lang.json. The zh assertions below need zh pinned.
beforeEach(() => setLangOverride('zh'))
afterEach(() => setLangOverride('auto'))

/** Wire-narrowed view of the published snapshot (host merge not needed here). */
interface ActivitySnapshot {
  phase: string
  line: string
  label?: string
  detail?: string
  phrase?: string
  toolCount: number
  turnElapsedMs: number
  phaseStartedAt: number
}

/** Narrow by the event's type tag (SessionEvent is a mapped type, not a union). */
function activityEvents(log: readonly SessionEvent[]): Array<SessionEvent & { data: ActivitySnapshot }> {
  return log.filter(event => event.type === 'activity/status').map(event => event as unknown as SessionEvent & { data: ActivitySnapshot })
}

/**
 * The assembled system prompt of one request.
 *
 * At 0.2.0-rc.2 a LOOP-built request leaves `GenerateOptions.system` undefined
 * by contract: the prompt is the leading `system`-role message in `messages`.
 */
function systemPromptOf(request: GenerateOptions | undefined): string {
  return (request?.messages ?? [])
    .filter(message => message.role === 'system')
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    .join('\n')
}

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  // Publish is opt-in in the shipped default (see Config.publish); these
  // integration tests exist to cover the publishing path, so enable it.
  // `lang: 'zh'` pins the copy through the plugin config (the ambient
  // machine may otherwise resolve en from the env/file/locale chain).
  await ctx.plugin(WorkingActivity, { publish: true, lang: 'zh' })
  // A real tool for the scripted tool call (bash is not composed here).
  ctx.tools.register(defineContentToolFixture({
    name: 'mock_ls',
    description: 'List files (mock)',
    parameters: { path: { type: 'string' } },
    async execute() {
      return [{ type: 'text', text: 'file-a.txt' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'mock_fail',
    description: 'Always fails (mock)',
    parameters: {},
    async execute() {
      throw new Error('mock failure')
    },
  }))
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Drain publish microtasks after the turn settles (append happens in a microtask). */
async function flushPublishes(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

describe('working-activity through the agent loop', () => {
  it('publishes tool-phase lines during a tool call and a done summary at turn end', async () => {
    // Responses are consumed in call order: the first model call must be the
    // tool call so the tool phase actually happens.
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'mock_ls', { path: 'src/dir' }, 'Listing files.'),
      textResponse('Done listing.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-activity'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'list files' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    await flushPublishes()

    const events = activityEvents(agent.session.snapshotEvents())
    expect(events.length).toBeGreaterThan(0)
    const phases = events.map(event => event.data.phase)
    expect(phases).toContain('tool')
    expect(phases).toContain('thinking')
    expect(phases).toContain('done')
    const toolLines = events.filter(event => event.data.phase === 'tool').map(event => event.data.line)
    expect(toolLines[0]).toContain('src/dir')
    const done = events.findLast(event => event.data.phase === 'done')
    expect(done?.data.line).toContain('1 工具')
  })

  it('a failed tool flags the done line', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'mock_fail', {}, 'Failing.'),
      textResponse('It failed.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-activity-fail'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run failing command' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    await flushPublishes()

    const done = activityEvents(agent.session.snapshotEvents()).findLast(event => event.data.phase === 'done')
    // Failure prefix draws from FAIL_PHRASES; assert the failure semantics.
    expect(done?.data.line).not.toContain('搞定')
  })

  it('each published snapshot is lossless JSON with optional fields omitted', async () => {
    const adapter = new MockAdapter([
      textResponse('Thinking hard.'),
      textResponse('All done.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-activity-json'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'think' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    await flushPublishes()

    for (const event of activityEvents(agent.session.snapshotEvents())) {
      const data = event.data as Record<string, unknown>
      expect(data.phase).toBeTruthy()
      // Idle bootstrap frames legitimately carry an empty line (see the
      // webui runtime patch's relaxed idle-frame validation); live phases
      // must always render a line.
      if (data.phase !== 'idle') expect(data.line).toBeTruthy()
      expect(JSON.stringify(data)).toBe(JSON.stringify(JSON.parse(JSON.stringify(data))))
    }
  })

  it('keeps the system prompt untouched and surfaces any ⏵ line only in the chip', async () => {
    // A model may independently emit a `⏵` line. Reasoning text must NOT
    // narrate; the chip can observe only visible text output.
    const adapter = new MockAdapter([
      [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: '用户要求 ⏵ 引用一下这个格式' },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: '用户要求 ⏵ 引用一下这个格式' } },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: '⏵ 查一下报错原因\n好的，我来看看。' },
        { type: 'block-end', index: 1, block: { type: 'text', text: '⏵ 查一下报错原因\n好的，我来看看。' } },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      textResponse('Done.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-activity-narrate'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'look into it' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    await flushPublishes()

    // The plugin never adds a status-line instruction to the primary prompt.
    expect(systemPromptOf(adapter.requests[0])).not.toContain('[状态栏]')
    // The streamed ⏵ line lands in the published status lines.
    const lines = activityEvents(agent.session.snapshotEvents()).map(event => event.data.line)
    expect(lines.some(line => line.includes('⏵ 查一下报错原因'))).toBe(true)
  })
})
