import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { historySeed } from '../src/continuation.ts'
import { parseHistory, digest } from '../src/import-parser.ts'
import * as plugin from '../src/index.ts'
import { IMPORT_PROMPT, REDUCE_PROMPT } from '../src/import-manager.ts'
import { importReplySchema } from '../src/import-schema.ts'
import type { Config } from '../src/schema.ts'
import { ownerPeer } from './peer.ts'
import { projectId } from '../src/store.ts'

const require = createRequire(import.meta.url)
const historyPath = join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json')), 'lib/types/history.js')
const { SessionHistoryController } = await import(pathToFileURL(historyPath).href) as typeof import('../node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/history.js')

const signal = () => new AbortController().signal
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
async function* text(value: string): AsyncGenerator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: value }; yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }; yield { type: 'finish', reason: { kind: 'stop' } }
}
async function root(t: { after(fn: () => Promise<void>): void }) {
  const base = join(process.cwd(), '.test-output'); await mkdir(base, { recursive: true }); const path = await mkdtemp(join(base, 'continuation-'))
  const contexts: Context[] = []
  t.after(async () => { for (const ctx of contexts.reverse()) await ctx.fiber.dispose(); assert.ok(path.startsWith(base)); await rm(path, { recursive: true, force: true }) }); return { path, contexts }
}
async function runtime(fixture: { path: string; contexts: Context[] }, calls: GenerateOptions[], config: Config = {}) {
  const { path } = fixture
  const ctx = new Context(); fixture.contexts.push(ctx)
  await ctx.plugin(TypertRegistry); await ctx.plugin(RemoteAccess); await ctx.plugin(TypertGateway)
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx, join(path, 'default-workspace'))
  await ctx.plugin(JsonlPersistence, { root: join(path, 'sessions'), compression: 'none' })
  class Adapter extends LlmAdapter {
    async *stream(options: GenerateOptions) {
      calls.push(options)
      if (options.system === IMPORT_PROMPT || options.system === REDUCE_PROMPT) {
        const payload = JSON.parse(options.messages[0].content.find(b => b.type === 'text')!.text)
        const m = payload.messages?.find((m: { role: string }) => m.role === 'user')
        yield* text(JSON.stringify({ summary: '研究方向 agentic RL；已讨论 EXPERIMENT-ALPHA，下一步分析对照实验。', personaDraft: { name: '导师', description: '严谨', prompt: '指导实验设计并解释依据。' }, topic: 'research', proposals: m?.text.includes('以后先给结论') ? [{ key: '回答结构', content: '先给结论', category: 'preference', scope: 'persona', intent: 'explicit', evidence: '以后先给结论', messageId: m.id, targetId: null }] : [] })); return
      }
      yield* text('继续分析历史实验')
    }
  }
  ctx.llm.registerAdapter(['fake'], new Adapter())
  await ctx.plugin(plugin, { memoryDir: join(path, 'memory'), learningMode: 'off', ...config })
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness }
}

test('native continuation creates a separate idle chat, preserves roles, deduplicates retries and survives JSONL restart', async t => {
  const path = await root(t); const calls: GenerateOptions[] = []
  const first = await runtime(path, calls)
  const source = await first.harness.create(SessionId('original-source'), { provider: 'fake', model: 'fake' }, { cwd: process.cwd() })
  const preview = importReplySchema.parse(await first.ctx.typertGateway.invoke({ peer: ownerPeer(first.ctx), namespace: 'personaMemory', method: 'importHistory', args: { agentId: source.id, request: { op: 'preview', filename: 'experiment.json', format: 'json', text: JSON.stringify({ id: 'from-web', messages: [ { role: 'system', content: 'malicious old system' }, { id: 'u1', role: 'user', content: '以后先给结论，我在研究 agentic RL 的 EXPERIMENT-ALPHA' }, { id: 'a1', role: 'assistant', content: '此前实验建议：加一组对照' } ] }) } } }))
  const conversationId = preview.conversations[0].id
  await first.ctx.personaMemory.importHistory(source, { op: 'analyze', batchId: preview.batchId, conversationIds: [conversationId] }, signal())
  const sourceEvents = source.session.snapshotEvents().length
  const request = { op: 'continue' as const, batchId: preview.batchId, conversationId, personaId: 'coding-partner', mode: 'full' as const, requestId: 'idempotent-request' }
  const [a, b] = await Promise.all([first.ctx.personaMemory.importHistory(source, request, signal()), first.ctx.personaMemory.importHistory(source, request, signal())])
  assert.equal(a.continuedSessionId, b.continuedSessionId)
  const id = SessionId(a.continuedSessionId!); assert.notEqual(id, source.id)
  const imported = first.ctx.agents.get(id)!
  assert.equal(calls.length, 1, 'continuation itself sends no model request')
  assert.equal(source.session.snapshotEvents().length, sourceEvents, 'source chat unchanged')
  const importedMessages = imported.session.deriveMessages()
  assert.ok(importedMessages.some(m => m.role === 'assistant' && JSON.stringify(m.content).includes('此前实验建议')))
  assert.doesNotMatch(JSON.stringify(importedMessages), /malicious old system/)
  assert.equal(first.ctx.personaMemory.currentEvidence(imported).length, 0)
  assert.equal((await first.ctx.personaMemory.dispatch(imported, { op: 'snapshot' })).selectedPersonaId, 'coding-partner')
  assert.equal((await first.ctx.sessionPersistence.stat(id))!.header.id, id)
  await first.ctx.fiber.dispose()
  const second = await runtime(path, calls)
  const handle = await second.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fake', model: 'fake' } })
  const resumed = handle.agent
  resumed.followup(user('接着这个实验，下一步如何安排？')); await resumed.whenIdle()
  assert.equal(calls.length, 2)
  assert.match(JSON.stringify(calls.at(-1)!.messages), /EXPERIMENT-ALPHA/)
  assert.match(JSON.stringify(calls.at(-1)!.messages), /coding-partner/)
  assert.match(JSON.stringify(calls.at(-1)!.messages), /此前实验建议/)
  const turns = resumed.session.snapshotEvents().filter(e => e.type === 'turn/start').map(e => e.data.turn)
  assert.deepEqual(turns, [1, 2])
  assert.equal(second.ctx.personaMemory.currentEvidence(resumed).length, 1)
  const original = await second.ctx.personaMemory.importer.history(id, 'EXPERIMENT-ALPHA')
  assert.equal(original.length, 1)
})

test('global management needs no session and keeps persona/project edits isolated from chat selection', async t => {
  const fixture = await root(t), calls: GenerateOptions[] = []
  const { ctx, harness } = await runtime(fixture, calls)
  const invoke = (view: object, request: object) => ctx.typertGateway.invoke({ peer: ownerPeer(ctx), namespace: 'personaMemory', method: 'manage', args: { view, request } })
  const view = { personaId: 'daily-companion', projectId: null }
  assert.equal(ctx.agents.list().length, 0)
  const initial = await invoke(view, { op: 'snapshot' }) as { selectedPersonaId: string }
  assert.equal(initial.selectedPersonaId, 'daily-companion')
  await invoke(view, { op: 'remember', expectedRevision: 0, memory: { personaId: 'daily-companion', projectId: null, key: '表达', content: '简短自然', category: 'preference', pinned: false } })
  assert.equal(ctx.agents.list().length, 0, 'no hidden management agent')
  assert.equal((await ctx.personaMemory.manage({ personaId: 'research-mentor', projectId: null }, { op: 'snapshot' })).memories.length, 0)
  await assert.rejects(invoke(view, { op: 'remember', expectedRevision: 0, memory: { personaId: 'research-mentor', projectId: null, key: '错位', content: '不得写入', category: 'fact', pinned: false } }), /切换/)
  const a = projectId(process.cwd())!, b = projectId(join(process.cwd(), 'another'))!
  const scoped = await ctx.personaMemory.manage({ ...view, projectId: a }, { op: 'remember', expectedRevision: 0, memory: { personaId: 'daily-companion', projectId: a, key: '项目', content: '此项目偏好', category: 'fact', pinned: false } })
  const memory = scoped.memories.find(m => m.projectId === a)!
  await assert.rejects(ctx.personaMemory.manage({ ...view, projectId: b }, { op: 'forget', personaId: view.personaId, memoryId: memory.id, expectedRevision: memory.revision }), /范围/)
  assert.equal((await ctx.personaMemory.manage(view, { op: 'snapshot' })).memories.length, 1)
  const agent = await harness.create(SessionId('unchanged-persona'))
  await invoke(view, { op: 'select', personaId: 'coding-partner' })
  assert.equal((await ctx.personaMemory.dispatch(agent, { op: 'snapshot' })).selectedPersonaId, 'research-mentor')
  assert.equal(calls.length, 0)
})

test('global import analyzes and continues with an explicit model, without creating a source chat', async t => {
  const fixture = await root(t), calls: GenerateOptions[] = []
  const { ctx } = await runtime(fixture, calls)
  const selection = { provider: 'fake', model: 'chosen-model', projectId: null }
  const invoke = (request: object) => ctx.typertGateway.invoke({ peer: ownerPeer(ctx), namespace: 'personaMemory', method: 'importManaged', args: { selection, request } })
  const preview = importReplySchema.parse(await invoke({ op: 'preview', filename: 'global.md', text: '## 用户\n以后先给结论，继续旧实验\n## 助手\n安排对照组', format: 'markdown' }))
  const conversationId = preview.conversations[0].id
  await invoke({ op: 'analyze', batchId: preview.batchId, conversationIds: [conversationId] })
  assert.equal(calls.length, 1); assert.equal(calls[0].model, 'chosen-model'); assert.equal(ctx.agents.list().length, 0)
  await invoke({ op: 'apply', batchId: preview.batchId, conversationIds: [conversationId], personaId: 'daily-companion' })
  assert.equal((await ctx.personaMemory.manage({ personaId: 'daily-companion', projectId: null }, { op: 'snapshot' })).memories.length, 1)
  const request = { op: 'continue', batchId: preview.batchId, conversationId, personaId: 'daily-companion', mode: 'full', requestId: 'global-continuation' }
  const first = importReplySchema.parse(await invoke(request)), second = importReplySchema.parse(await invoke(request))
  assert.equal(first.continuedSessionId, second.continuedSessionId); assert.equal(ctx.agents.list().length, 1); assert.equal(calls.length, 1)
  const agent = ctx.agents.get(SessionId(first.continuedSessionId!))!
  assert.equal(agent.options.model, 'chosen-model'); assert.equal(agent.session.header.cwd, join(fixture.path, 'default-workspace'))
  assert.equal((await ctx.personaMemory.dispatch(agent, { op: 'snapshot' })).selectedPersonaId, 'daily-companion')
  assert.equal((await ctx.sessionPersistence.stat(agent.id))!.header.id, agent.id)
})

// Exact observations, preparation leases and replay are the production query implementation.
// Search is not called by the history page/follow APIs exercised here.
class ExactQuery extends SessionQueryEngine {
  async searchSessions(): Promise<never> { throw new Error('Search is outside this history regression') }
  async searchEvents(): Promise<never> { throw new Error('Search is outside this history regression') }
}
async function historyApi(ctx: Context) {
  await ctx.plugin(ExactQuery)
  return new SessionHistoryController(ctx, () => {})
}

test('Desktop history page/follow reject legacy no-cwd seeds and load new continuations live and after a cold restart', async t => {
  const fixture = await root(t), calls: GenerateOptions[] = []
  const first = await runtime(fixture, calls), history = await historyApi(first.ctx)
  const selection = { provider: 'fake', model: 'fake', projectId: null }
  const preview = await first.ctx.personaMemory.importManaged(selection, { op: 'preview', filename: 'history.md', text: '## 用户\n历史问题 JAVA-GENERICS\n## 助手\n完整保留的历史答案', format: 'markdown' }, signal())
  const request = { op: 'continue' as const, batchId: preview.batchId, conversationId: preview.conversations[0].id, personaId: 'daily-companion', mode: 'full' as const, requestId: 'same-click-as-legacy' }
  const oldId = SessionId(`session-import-${digest(`${request.batchId}:${request.conversationId}:${request.personaId}:${request.requestId}`).slice(0, 32)}`)
  const raw = parseHistory('history.md', '## 用户\n历史问题 JAVA-GENERICS\n## 助手\n完整保留的历史答案', 'markdown')
  const legacy = await first.ctx.agents.create({ sessionId: oldId, seed: historySeed(raw.conversations[0], oldId, preview.batchId, 'full', 24000), agentOptions: { provider: 'fake', model: 'fake' } })
  await first.ctx.parallel('session/flush', legacy.agent.session)
  await first.ctx.personaMemory.store.writeArtifact('continuations', oldId, { batchId: request.batchId, conversationId: request.conversationId, personaId: request.personaId, sessionId: oldId, complete: true })
  await assert.rejects(history.page({ address: { kind: 'session', sessionId: oldId }, throughSeq: legacy.agent.session.seq - 1 }, signal()), /not found/, 'reproduce the screenshot despite a valid persisted history')

  const result = await first.ctx.personaMemory.importManaged(selection, request, signal())
  const id = SessionId(result.continuedSessionId!)
  assert.notEqual(id, oldId, 'never reuse old invalid complete receipts')
  const cwd = join(fixture.path, 'default-workspace')
  assert.equal(first.ctx.agents.get(id)!.session.header.cwd, cwd)
  assert.equal((await first.ctx.sessionPersistence.stat(id))!.header.cwd, cwd)
  assert.equal((await first.ctx.sessionPersistence.stat(oldId))!.header.cwd, undefined, 'legacy files remain intact')
  const lastSeq = first.ctx.agents.get(id)!.session.seq - 1
  const page = await history.page({ address: { kind: 'session', sessionId: id }, throughSeq: lastSeq }, signal())
  assert.match(JSON.stringify(page), /JAVA-GENERICS/); assert.match(JSON.stringify(page), /完整保留的历史答案/)
  const abort = new AbortController(), follow = history.follow({ address: { kind: 'session', sessionId: id } }, abort.signal)[Symbol.asyncIterator]()
  const opening = await follow.next()
  assert.match(JSON.stringify(opening.value), /JAVA-GENERICS/)
  abort.abort(); await follow.return?.()
  assert.equal((await first.ctx.personaMemory.importManaged(selection, request, signal())).continuedSessionId, id)
  assert.equal(calls.length, 0, 'creation and UI history loading send no model requests')
  await first.ctx.fiber.dispose()

  const second = await runtime(fixture, calls), coldHistory = await historyApi(second.ctx)
  assert.equal(second.ctx.agents.list().length, 0)
  const coldPage = await coldHistory.page({ address: { kind: 'session', sessionId: id }, throughSeq: lastSeq }, signal())
  assert.match(JSON.stringify(coldPage), /JAVA-GENERICS/)
  assert.equal(second.ctx.agents.list().length, 0, 'cold history reads do not require an active agent')
  assert.equal((await second.ctx.personaMemory.importManaged(selection, request, signal())).continuedSessionId, id)
  const resumed = await second.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fake', model: 'fake' } })
  resumed.agent.followup(user('接着历史问题继续')); await resumed.agent.whenIdle()
  assert.equal(calls.length, 1); assert.match(JSON.stringify(calls[0].messages), /JAVA-GENERICS/)
})

test('selected project directories override the deployment default and produce readable history', async t => {
  const fixture = await root(t), calls: GenerateOptions[] = []
  const { ctx, harness } = await runtime(fixture, calls), history = await historyApi(ctx)
  const cwd = join(fixture.path, 'chosen-project'); await mkdir(cwd)
  await harness.create(SessionId('project-source'), { provider: 'fake', model: 'fake' }, { cwd })
  const selection = { provider: 'fake', model: 'fake', projectId: projectId(cwd) }
  const preview = await ctx.personaMemory.importManaged(selection, { op: 'preview', filename: 'project.md', text: '## 用户\n项目历史\n## 助手\n项目答案', format: 'markdown' }, signal())
  const result = await ctx.personaMemory.importManaged(selection, { op: 'continue', batchId: preview.batchId, conversationId: preview.conversations[0].id, personaId: 'coding-partner', mode: 'full', requestId: 'chosen-project' }, signal())
  const id = SessionId(result.continuedSessionId!), agent = ctx.agents.get(id)!
  assert.equal(agent.session.header.cwd, cwd)
  assert.equal((await ctx.sessionPersistence.stat(id))!.header.cwd, cwd)
  assert.match(JSON.stringify(await history.page({ address: { kind: 'session', sessionId: id }, throughSeq: agent.session.seq - 1 }, signal())), /项目答案/)
  assert.equal(calls.length, 0)
})

test('real DSH stream failures do not become JSON errors; token-limited analysis retries with a larger budget', async t => {
  const fixture = await root(t), calls: GenerateOptions[] = []
  const { ctx } = await runtime(fixture, calls)
  let count = 0
  class Broken extends LlmAdapter {
    async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      count++; calls.push(options)
      if (options.model === 'denied') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH_FAILED', message: 'private credential echo', status: 401 } } }; return
      }
      if (count === 2) { yield { type: 'reasoning-delta', index: 0, text: 'thinking' }; yield { type: 'finish', reason: { kind: 'max-tokens' } }; return }
      yield* text(JSON.stringify({ summary: '已提取', personaDraft: { name: '导师', description: '', prompt: '指导实验' }, topic: 'research', proposals: [] }))
    }
  }
  ctx.llm.registerAdapter(['fault-test'], new Broken())
  const preview = await ctx.personaMemory.importManaged({ provider: 'fault-test', model: 'denied', projectId: null }, { op: 'preview', filename: 'fault.md', text: '## 用户\n讨论实验\n## 助手\n给出建议', format: 'markdown' }, signal())
  const request = { op: 'analyze' as const, batchId: preview.batchId, conversationIds: [preview.conversations[0].id] }
  await assert.rejects(ctx.personaMemory.importManaged({ provider: 'fault-test', model: 'denied', projectId: null }, request, signal()), error => {
    assert.match(String(error), /模型请求失败.*401/); assert.doesNotMatch(String(error), /JSON|private credential/); return true
  })
  assert.equal(count, 1, 'provider errors are not automatically retried')
  const result = await ctx.personaMemory.importManaged({ provider: 'fault-test', model: 'truncated', projectId: null }, request, signal())
  assert.ok(result.conversations[0].analysis); assert.equal(count, 3)
  assert.deepEqual(calls.slice(-2).map(c => c.maxTokens), [8192, 16384])
  assert.equal(ctx.agents.list().length, 0)
})

test('long histories keep the full transcript while sending a bounded summary and recent text; history tool retrieves omitted details', async t => {
  const path = await root(t); const calls: GenerateOptions[] = []
  const { ctx, harness } = await runtime(path, calls, { continuationChars: 8000 })
  const source = await harness.create(SessionId('long-source'), { provider: 'fake', model: 'fake' })
  const preview = await ctx.personaMemory.importHistory(source, { op: 'preview', filename: 'long.json', format: 'json', text: JSON.stringify({ id: 'long-web', messages: [{ id: 'u-old', role: 'user', content: 'ARCHIVE-ONLY-DETAIL ' + 'old experiment '.repeat(2000) }, { id: 'a-old', role: 'assistant', content: 'historical answer '.repeat(1000) }, { id: 'u-last', role: 'user', content: 'LATEST-QUESTION' }] }) }, signal())
  const conversationId = preview.conversations[0].id
  const request = { op: 'continue' as const, batchId: preview.batchId, conversationId, personaId: 'research-mentor', mode: 'summary' as const, requestId: 'long-history' }
  await assert.rejects(ctx.personaMemory.importHistory(source, request, signal()), /先完成/)
  await ctx.personaMemory.importHistory(source, { op: 'analyze', batchId: preview.batchId, conversationIds: [conversationId] }, signal())
  await assert.rejects(ctx.personaMemory.importHistory(source, { ...request, mode: 'full' }, signal()), /超过续聊预算/)
  const reply = await ctx.personaMemory.importHistory(source, request, signal())
  const imported = ctx.agents.get(SessionId(reply.continuedSessionId!))!
  assert.match(JSON.stringify(imported.session.snapshotEvents()), /ARCHIVE-ONLY-DETAIL/)
  assert.doesNotMatch(JSON.stringify(imported.session.deriveMessages()), /ARCHIVE-ONLY-DETAIL/)
  assert.ok(JSON.stringify(imported.session.deriveMessages()).length < 10000)
  assert.match(JSON.stringify(imported.session.deriveMessages()), /LATEST-QUESTION/)
  const result = await ctx.tools.execute({ name: 'persona_history', callId: ToolCallId('history-read'), agent: imported, arguments: { query: 'ARCHIVE-ONLY-DETAIL' }, signal: signal() })
  assert.equal(result.isError, false)
  assert.match(JSON.stringify(result.value), /ARCHIVE-ONLY-DETAIL/)
  assert.ok(JSON.stringify(result.value).length < 14000)
  imported.followup(user('继续这个实验')); await imported.whenIdle()
  assert.doesNotMatch(JSON.stringify(calls.at(-1)!.messages), /ARCHIVE-ONLY-DETAIL/)
  assert.match(JSON.stringify(calls.at(-1)!.messages), /LATEST-QUESTION/)
  assert.deepEqual(imported.session.snapshotEvents().filter(e => e.type === 'turn/start').map(e => e.data.turn), [1, 2, 3])
  await ctx.personaMemory.flushCaptures()
  assert.equal((await ctx.personaMemory.store.journal()).jobs.length, 0)
})
