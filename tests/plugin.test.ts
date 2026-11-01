import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../src/index.ts'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { snapshotSchema } from '../src/schema.ts'
import { ownerPeer } from './peer.ts'

test('real Harness loop logs persona snapshots, switches next turn and recalls in a new session', async t => {
  const base = join(process.cwd(), '.test-output')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'loop-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); assert.ok(root.startsWith(base)); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(TypertGateway)
  await mountAgentLoopTestDependencies(ctx)
  const calls: GenerateOptions[] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  t.after(() => release.resolve())
  class FakeAdapter extends LlmAdapter {
    async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      calls.push(options)
      if (calls.length === 1) { entered.resolve(); await release.promise }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '测试回复' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '测试回复' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test'], new FakeAdapter())
  await ctx.plugin(plugin, { memoryDir: root, learningMode: 'off' })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('first'), { provider: 'test', model: 'test' })
  const remote = snapshotSchema.parse(await ctx.typertGateway.invoke({ peer: ownerPeer(ctx), namespace: 'personaMemory', method: 'dispatch', args: { agentId: agent.id, request: { op: 'snapshot' } } }))
  assert.equal(remote.personas.length, 3)
  await assert.rejects(ctx.typertGateway.invoke({ peer: ownerPeer(ctx), namespace: 'personaMemory', method: 'dispatch', args: { agentId: agent.id, request: { op: 'select', personaId: '../../escape' } } }))
  await ctx.personaMemory.dispatch(agent, { op: 'remember', expectedRevision: 0, memory: { personaId: 'research-mentor', projectId: null, key: '科研习惯', content: '长期偏好标记 ALPHA', category: 'preference', pinned: true } })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '讨论论文' }] }))
  await entered.promise
  const pending = await ctx.personaMemory.dispatch(agent, { op: 'select', personaId: 'daily-companion' })
  assert.equal(pending.activePersonaId, 'research-mentor')
  assert.equal(pending.selectedPersonaId, 'daily-companion')
  release.resolve()
  await agent.whenIdle()
  assert.equal(calls.length, 1)
  const text = JSON.stringify(calls[0].messages)
  assert.match(text, /科研导师/)
  assert.match(text, /ALPHA/)
  const snapshot = agent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.source.kind === 'persona-memory')
  assert.ok(snapshot)
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '聊聊今天' }] }))
  await agent.whenIdle()
  assert.equal(calls.length, 2)
  assert.match(JSON.stringify(calls[1].messages), /日常陪伴/)
  // Shared chat history retains ALPHA; the NEW memory snapshot contains none.
  const last = [...agent.session.snapshotEvents()].reverse().find(e => e.type === 'user/message' && e.data.source.kind === 'persona-memory')
  assert.ok(last && last.type === 'user/message')
  assert.doesNotMatch(JSON.stringify(last.data.content), /ALPHA/)
  await ctx.personaMemory.dispatch(agent, { op: 'select', personaId: 'research-mentor' })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '回到科研' }] }))
  await agent.whenIdle()
  const restored = [...agent.session.snapshotEvents()].reverse().find(e => e.type === 'user/message' && e.data.source.kind === 'persona-memory')
  assert.ok(restored && restored.type === 'user/message')
  assert.match(JSON.stringify(restored.data.content), /ALPHA/)
  const fresh = await harness.create(SessionId('second'), { provider: 'test', model: 'test' })
  fresh.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续科研' }] }))
  await fresh.whenIdle()
  assert.match(JSON.stringify(calls[3].messages), /ALPHA/)
})
