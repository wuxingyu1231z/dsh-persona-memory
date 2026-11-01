import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../src/index.ts'
import { EXTRACTION_PROMPT } from '../src/learning.ts'
import type { Config, Proposal } from '../src/schema.ts'
import { projectId } from '../src/store.ts'

async function fixture(t: { after(fn: () => Promise<void>): void }, stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>, config: Config = {}) {
  const base = join(process.cwd(), '.test-output'); await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'stage2-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); assert.ok(root.startsWith(base)); await rm(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  class Adapter extends LlmAdapter { override stream(options: GenerateOptions) { return stream(options) } }
  ctx.llm.registerAdapter(['fake'], new Adapter())
  const fiber = ctx.plugin(plugin, { memoryDir: root, learningMaxAttempts: 1, ...config }); await fiber
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('stage2'), { provider: 'fake', model: 'fake' }, { cwd: process.cwd() })
  return { ctx, agent, root, fiber }
}
async function* text(value: string): AsyncGenerator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: value }; yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }; yield { type: 'finish', reason: { kind: 'stop' } }
}
async function* call(name: string, args: object): AsyncGenerator<StreamChunk> {
  const id = ToolCallId('model-call')
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
const user = (value: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] })
test('queued prompts keep the persona chosen when submitted, even after a later switch', async t => {
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
  t.after(async () => release.resolve())
  const seen: string[] = []
  const { ctx, agent } = await fixture(t, async function* (options) {
    const system = options.messages.find(m => m.role === 'system')!
    seen.push(JSON.stringify(system.content))
    if (seen.length === 1) { started.resolve(); await release.promise }
    yield* text('ok')
  }, { learningMode: 'off' })
  agent.followup(user('first')); await started.promise
  agent.followup(user('queued before switch'))
  await ctx.personaMemory.dispatch(agent, { op: 'select', personaId: 'daily-companion' })
  agent.followup(user('queued after switch'))
  release.resolve(); await agent.whenIdle()
  assert.equal(seen.length, 3)
  assert.match(seen[0], /research-mentor/); assert.match(seen[1], /research-mentor/); assert.match(seen[2], /daily-companion/)
})
test('background learning uses original persona and user evidence after a UI switch; reload resumes without duplication', async t => {
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
  t.after(async () => release.resolve())
  let extractionCalls = 0
  const { ctx, agent, fiber, root } = await fixture(t, async function* (options) {
    if (options.system === EXTRACTION_PROMPT) {
      extractionCalls++
      const payload = JSON.parse(options.messages[0].content.find(b => b.type === 'text')!.text)
      assert.doesNotMatch(JSON.stringify(payload.messages), /助手捏造的偏好/)
      const proposal: Proposal = { key: '结构', content: '先给结论', category: 'preference', scope: 'persona', intent: 'explicit', evidence: '以后先给结论', messageId: payload.messages[0].messageId, targetId: null }
      yield* text(JSON.stringify({ proposals: [proposal] })); return
    }
    started.resolve(); await release.promise
    yield* text('助手捏造的偏好：用户喜欢长篇闲聊')
  })
  agent.followup(user('以后先给结论'))
  await started.promise
  await ctx.personaMemory.dispatch(agent, { op: 'select', personaId: 'daily-companion' })
  release.resolve(); await agent.whenIdle()
  await ctx.personaMemory.flushCaptures(); await ctx.personaMemory.worker.kick()
  assert.equal((await ctx.personaMemory.store.memories('research-mentor'))[0].content, '先给结论')
  assert.equal((await ctx.personaMemory.store.memories('daily-companion')).length, 0)
  assert.equal(extractionCalls, 1)
  await fiber.dispose()
  await ctx.plugin(plugin, { memoryDir: root, learningMaxAttempts: 1 })
  await ctx.personaMemory.worker.kick()
  assert.equal(extractionCalls, 1)
  assert.equal((await ctx.personaMemory.dispatch(agent, { op: 'snapshot' })).selectedPersonaId, 'daily-companion')
})
test('the model can save explicit memory through its bound tool and cannot supply another persona ID', async t => {
  let main = 0
  const { ctx, agent } = await fixture(t, async function* (options) {
    if (main++ === 0) yield* call('persona_memory', { op: 'remember', key: '回答方式', content: '先给结论', evidence: '以后先给结论' })
    else yield* text('已经保存')
  }, { learningMode: 'off' })
  agent.followup(user('以后先给结论')); await agent.whenIdle()
  assert.equal((await ctx.personaMemory.store.memories('research-mentor'))[0].content, '先给结论')
  const invalid = await ctx.tools.execute({ name: 'persona_memory', arguments: { op: 'search', personaId: 'daily-companion' }, callId: ToolCallId('invalid'), signal: new AbortController().signal, agent })
  assert.equal(invalid.isError, true)
  const fabricated = await ctx.tools.execute({ name: 'persona_memory', arguments: { op: 'remember', key: '假的', content: '假的', evidence: '不存在的原话' }, callId: ToolCallId('bad-source'), signal: new AbortController().signal, agent })
  assert.equal(fabricated.isError, true)
})
test('verification uses actual exit codes and the ordinary permission pipeline', async t => {
  const { ctx, agent } = await fixture(t, () => text('ok'), { learningMode: 'off', verificationChecks: [{ id: 'unit', label: '单元检查', tool: 'fixture_check', arguments: {} }] })
  let code = 0; let denied = false; let policyCalls = 0
  ctx.tools.register({ name: 'fixture_check', description: 'fixture', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object', properties: { exitCode: { type: 'number' } }, required: ['exitCode'] }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] }, execute: async () => ({ exitCode: code }) })
  ctx.on('tools/pre-execute', async (exec, next) => { if (exec.name === 'fixture_check') { policyCalls++; if (denied) return { kind: 'deny', reason: 'test policy' } }; return next() })
  const verify = () => ctx.tools.execute({ name: 'persona_verify', arguments: {}, callId: ToolCallId(`v-${code}-${denied}`), signal: new AbortController().signal, agent })
  let result = await verify(); assert.equal(result.isError, false); if (!result.isError) assert.match(JSON.stringify(result.value), /passed/)
  code = 1; result = await verify(); if (!result.isError) assert.match(JSON.stringify(result.value), /failed/)
  denied = true; result = await verify(); if (!result.isError) assert.match(JSON.stringify(result.value), /blocked/)
  assert.equal(policyCalls, 3)
  assert.equal((await ctx.personaMemory.dispatch(agent, { op: 'snapshot' })).verification.status, 'blocked')
})
test('memory is re-injected when surface compaction shadows its previous snapshot', async t => {
  const { ctx, agent } = await fixture(t, () => text('ok'), { learningMode: 'off' })
  agent.followup(user('hello')); await agent.whenIdle()
  const event = [...agent.session.snapshotEvents()].reverse().find(e => e.type === 'user/message' && e.data.source.kind === 'persona-memory')!
  // Simulate the same surface replacement a compaction provider commits.
  agent.session.append('user/message', createUserMessage({ source: { kind: 'persona-verification', form: 'state', verification: { status: 'not-run', checks: [], at: null } }, content: [{ type: 'text', text: '压缩摘要' }] }), { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] })
  assert.ok(ctx.personaMemory.context(agent, []))
})

test('memory index/read paginate within the bound persona and project without loading foreign records', async t => {
  const { ctx, agent } = await fixture(t, () => text('ok'), { learningMode: 'off' })
  const save = (personaId: string, project: string | null, key: string) => ctx.personaMemory.store.remember({ personaId, projectId: project, key, content: key + '-body', category: 'fact', pinned: false }, 0, { kind: 'user' })
  const global = await save('research-mentor', null, 'global')
  await save('research-mentor', projectId(process.cwd()), 'project')
  const foreign = await save('research-mentor', 'foreign-project', 'FOREIGN-PROJECT')
  const other = await save('daily-companion', null, 'FOREIGN-PERSONA')
  await ctx.personaMemory.refreshActive(agent)
  const run = (arguments_: object) => ctx.tools.execute({ name: 'persona_memory', arguments: arguments_, callId: ToolCallId('index-read'), signal: new AbortController().signal, agent })
  const result = await run({ op: 'index', limit: 1 }); assert.equal(result.isError, false)
  if (result.isError) return
  const index = JSON.parse((result.value as { detail: string }).detail)
  assert.equal(index.total, 2); assert.equal(index.entries.length, 1); assert.equal(index.nextOffset, 1)
  assert.doesNotMatch(JSON.stringify(index), /FOREIGN/)
  const second = await run({ op: 'index', offset: 1, limit: 1 }); if (!second.isError) assert.equal(JSON.parse((second.value as { detail: string }).detail).nextOffset, null)
  const read = await run({ op: 'read', memoryId: global.id }); assert.equal(read.isError, false); assert.match(JSON.stringify(read.value), /global-body/)
  assert.equal((await run({ op: 'read', memoryId: foreign.id })).isError, true)
  assert.equal((await run({ op: 'read', memoryId: other.id })).isError, true)
  assert.equal((await run({ op: 'read', memoryId: '../../escape' })).isError, true)
})

test('the real chat loop reads matching bodies through the index and logs a bounded selected snapshot', async t => {
  const { ctx, agent } = await fixture(t, () => text('ok'), { learningMode: 'off', recallLimit: 2, maxContextChars: 4000 })
  for (let i = 0; i < 24; i++) await ctx.personaMemory.store.remember({ personaId: 'research-mentor', projectId: null, key: `topic-${i}`, content: i === 17 ? 'needleomega 可验证的实验事实' : 'UNRELATED-BODY '.repeat(40), category: 'fact', pinned: false }, 0, { kind: 'user' })
  await ctx.personaMemory.refreshActive(agent)
  const reads: string[] = [], original = Reflect.get(ctx.personaMemory.store, 'readMemoryFile') as (path: string) => Promise<unknown>
  Reflect.set(ctx.personaMemory.store, 'readMemoryFile', function (path: string) { reads.push(path); return original.call(ctx.personaMemory.store, path) })
  agent.followup(user('请解释 needleomega')); await agent.whenIdle()
  const source = agent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.source.kind === 'persona-memory')!
  assert.equal(source.type, 'user/message'); if (source.type !== 'user/message' || source.data.source.kind !== 'persona-memory') return
  const snapshot = source.data.source.snapshot as { memories: unknown[] }
  assert.equal(snapshot.memories.length, 1); assert.equal(reads.length, 1)
  const body = JSON.stringify(source.data.content)
  assert.match(body, /MEMORY.md/); assert.match(body, /needleomega/); assert.doesNotMatch(body, /UNRELATED-BODY/); assert.ok(body.length < 4000)
})
