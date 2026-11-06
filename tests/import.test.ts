import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parseHistory } from '../src/import-parser.ts'
import { ImportManager, REDUCE_PROMPT, chunks } from '../src/import-manager.ts'
import { batchSchema, type ImportAnalysis, type HistoryMessage } from '../src/import-schema.ts'
import { MemoryStore } from '../src/store.ts'
import { configSchema } from '../src/schema.ts'
import { readImportOutput, ImportOutputError } from '../src/import-output.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const fakeAgent = { id: 'source-chat', session: { header: { cwd: process.cwd() }, snapshotEvents: () => [] }, options: { provider: 'fake', model: 'fake' } } as unknown as Agent
const analysis = (messages: HistoryMessage[]): ImportAnalysis => ({ summary: '正在研究 agentic RL，下一步比较两个实验。', personaDraft: { name: '研究导师', description: '逻辑严谨', prompt: '给出具体可验证的科研建议。' }, topic: 'research', proposals: messages.filter(m => m.role === 'user' && m.text.includes('以后先给结论')).map(m => ({ key: '回答结构', content: '先给结论', category: 'preference', scope: 'persona', intent: 'explicit', evidence: '以后先给结论', messageId: m.id, targetId: null })) })
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = join(process.cwd(), '.test-output'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'import-'))
  t.after(() => { assert.ok(root.startsWith(base)); return rm(root, { recursive: true, force: true }) })
  const store = new MemoryStore(root); await store.initialize(); return { store, root }
}
const signal = () => new AbortController().signal
const json = (text = '以后先给结论') => JSON.stringify({ id: 'official-conversation', title: '研究', messages: [{ id: 'u1', role: 'user', content: text }, { id: 'a1', role: 'assistant', content: '助手捏造的偏好' }] })

test('DeepSeek mapping imports REQUEST/RESPONSE, dates and branches but omits thinking and files', () => {
  const raw = [{ id: 'deepseek-id', title: '实验', current_node: 'a2', mapping: {
    root: { parent: null, message: null },
    u1: { parent: 'root', message: { inserted_at: '2025-01-02T00:00:00Z', fragments: [{ type: 'REQUEST', content: '我的方向是 agentic RL' }, { type: 'FILE', files: ['missing.pdf'] }] } },
    a1: { parent: 'u1', message: { fragments: [{ type: 'THINK', content: 'hidden chain' }, { type: 'RESPONSE', content: '旧分支' }] } },
    a2: { parent: 'u1', message: { fragments: [{ type: 'RESPONSE', content: '当前分支' }] } },
  } }]
  const batch = parseHistory('deepseek.json', JSON.stringify(raw), 'auto')
  assert.equal(batch.conversations.length, 2)
  const c = batch.conversations.find(c => c.preferred)!
  assert.equal(c.platform, 'deepseek'); assert.equal(c.branchId, 'a2'); assert.equal(c.messages[0].at, Date.parse('2025-01-02T00:00:00Z'))
  assert.doesNotMatch(JSON.stringify(batch.conversations.map(c => c.messages)), /hidden chain|missing.pdf/)
  assert.match(batch.warnings.join(' '), /附件/)
})

test('ChatGPT current_node remains separate from sibling branches and original system messages are skipped', () => {
  const content = (role: string, text: string) => ({ author: { role }, content: { content_type: 'text', parts: [text] }, create_time: 1700000000 })
  const raw = { id: 'gpt', title: '标题', current_node: 'a', mapping: { s: { parent: null, message: content('system', 'old system command') }, u: { parent: 's', message: content('user', 'hello') }, a: { parent: 'u', message: content('assistant', 'selected') }, b: { parent: 'u', message: content('assistant', 'sibling') } } }
  const batch = parseHistory('chatgpt.json', '\uFEFF' + JSON.stringify({ conversations: [raw] }), 'json')
  assert.equal(batch.conversations.length, 2)
  assert.deepEqual(batch.conversations[0].messages.map(m => m.text), ['hello', 'selected'])
  assert.deepEqual(batch.conversations[1].messages.map(m => m.text), ['hello', 'sibling'])
  assert.equal(batch.conversations[0].messages[0].at, 1700000000000)
  assert.equal(parseHistory('renamed.json', JSON.stringify(raw), 'auto').conversations[0].id, batch.conversations[0].id)
})

test('malformed graphs, ambiguous roles and over-budget imports are rejected before analysis', () => {
  const wrap = (mapping: object) => JSON.stringify({ mapping })
  assert.throws(() => parseHistory('x', wrap({ a: { parent: 'missing' } }), 'json'), /缺失/)
  assert.throws(() => parseHistory('x', wrap({ a: { parent: 'b' }, b: { parent: 'a' }, c: { parent: null } }), 'json'), /循环/)
  assert.throws(() => parseHistory('x', wrap({ a: { parent: null, message: { fragments: [{ type: 'REQUEST', content: 'u' }, { type: 'RESPONSE', content: 'a' }] } } }), 'json'), /混合/)
  assert.throws(() => parseHistory('x', json(), 'json', { chars: 10, conversations: 10, branches: 4, messages: 10 }), /上限/)
  assert.throws(() => parseHistory('x', '无法猜测角色的普通笔记', 'markdown'), /明确角色/)
})

test('role-marked Markdown preserves fenced text and literal markup without inventing timestamps', () => {
  const batch = parseHistory('chat.md', '# 我的实验\n## 用户\n以后先给结论\n```md\n## 助手\nnot a new turn\n```\n## 助手\n<script>literal</script>\nUser: 下一步', 'auto')
  assert.equal(batch.conversations[0].messages.length, 3)
  assert.match(batch.conversations[0].messages[0].text, /## 助手/)
  assert.equal(batch.conversations[0].messages[1].text, '<script>literal</script>')
  assert.ok(batch.conversations[0].messages.every(m => m.at === null))
})

test('analysis automatically saves imported memories, deduplicates evidence and supports separate target personas', async t => {
  const { store } = await fixture(t); let calls = 0
  const manager = new ImportManager(store, configSchema.parse({ learningMode: 'off' }), async (_agent, _system, payload) => { calls++; const a = analysis((payload as { messages: HistoryMessage[] }).messages); a.proposals.push({ ...a.proposals[0], messageId: 'a1', evidence: '助手捏造的偏好' }); return JSON.stringify(a) }, async () => 'new-chat')
  const preview = await manager.handle(fakeAgent, { op: 'preview', filename: 'export.json', text: json(), format: 'json' }, signal())
  const id = preview.conversations[0].id
  await manager.handle(fakeAgent, { op: 'analyze', batchId: preview.batchId, conversationIds: [id] }, signal())
  await manager.handle(fakeAgent, { op: 'analyze', batchId: preview.batchId, conversationIds: [id] }, signal())
  assert.equal(calls, 1)
  const apply = { op: 'apply' as const, batchId: preview.batchId, conversationIds: [id], personaId: 'imported-mentor', newPersona: { id: 'imported-mentor', name: '导师', description: '严谨', prompt: '具体的指导' } }
  assert.equal((await manager.handle(fakeAgent, apply, signal())).savedMemories, 1)
  assert.equal((await manager.handle(fakeAgent, apply, signal())).savedMemories, 0)
  let journal = await store.journal(); assert.equal(journal.candidates.length, 1); assert.equal(journal.candidates[0].sources.length, 1); assert.equal(journal.candidates[0].origin, 'import')
  assert.equal((await store.memories('imported-mentor')).length, 1)
  assert.equal(journal.candidates[0].status, 'accepted')
  assert.equal((await store.memories('imported-mentor'))[0].source.kind, 'import')
  await manager.handle(fakeAgent, { ...apply, personaId: 'daily-companion', newPersona: undefined }, signal())
  journal = await store.journal(); assert.equal(journal.candidates.filter(c => c.personaId === 'daily-companion').length, 1)
  assert.equal((await manager.list()).length, 1)
})

test('old imports never automatically overwrite current or locked memories', async t => {
  const { store } = await fixture(t)
  const memory = await store.remember({ personaId: 'research-mentor', projectId: null, key: '回答结构', content: '详细推导', category: 'preference', pinned: false }, 0, { kind: 'user' })
  const manager = new ImportManager(store, configSchema.parse({}), async (_a, _s, payload) => JSON.stringify(analysis((payload as { messages: HistoryMessage[] }).messages)), async () => '')
  const preview = await manager.handle(fakeAgent, { op: 'preview', filename: 'x.json', text: json(), format: 'auto' }, signal())
  const ids = preview.conversations.map(c => c.id)
  await manager.handle(fakeAgent, { op: 'analyze', batchId: preview.batchId, conversationIds: ids }, signal())
  await manager.handle(fakeAgent, { op: 'apply', batchId: preview.batchId, conversationIds: ids, personaId: memory.personaId }, signal())
  assert.equal((await store.memories(memory.personaId))[0].content, '详细推导')
  assert.equal((await store.journal()).candidates[0].reason, 'stale')
  await store.configureMemory(memory.personaId, memory.id, 1, true, null)
  const c = (await store.journal()).candidates[0]
  assert.equal(c.status, 'rejected'); assert.equal((await store.journal()).candidates.filter(c => c.status === 'pending').length, 0)
})

test('automatic import keeps the last supported correction within an undated conversation', async t => {
  const { store } = await fixture(t)
  const manager = new ImportManager(store, configSchema.parse({}), async (_a, _s, payload) => {
    const messages = (payload as { messages: HistoryMessage[] }).messages
    return JSON.stringify({ ...analysis([]), proposals: messages.filter(m => m.role === 'user').map(m => ({ key: '回答结构', content: m.text, category: 'preference', scope: 'persona', intent: 'explicit', evidence: m.text, messageId: m.id, targetId: null })).reverse() })
  }, async () => '')
  const preview = await manager.handle(fakeAgent, { op: 'preview', filename: 'correction.md', format: 'markdown', text: '## 用户\n我喜欢详细推导\n## 助手\n好的\n## 用户\n以后改为先给结论' }, signal())
  const conversationIds = preview.conversations.map(c => c.id)
  await manager.handle(fakeAgent, { op: 'analyze', batchId: preview.batchId, conversationIds }, signal())
  const reply = await manager.handle(fakeAgent, { op: 'apply', batchId: preview.batchId, conversationIds, personaId: 'research-mentor' }, signal())
  const memories = await store.memories('research-mentor')
  assert.equal(reply.savedMemories, 1); assert.equal(memories.length, 1); assert.equal(memories[0].content, '以后改为先给结论')
  assert.equal(memories[0].source.observedAt, 0, 'relative order never invents an absolute date')
})

test('cancelled chunk analysis resumes checkpoints; changed model invalidates cached analyses', async t => {
  const { store } = await fixture(t); let calls = 0; let fail = true
  const manager = new ImportManager(store, configSchema.parse({ importInputChars: 12000 }), async (_a, system, payload) => {
    calls++
    if (calls === 2 && fail) { fail = false; throw new Error('interrupted') }
    return JSON.stringify(system === REDUCE_PROMPT ? analysis([]) : analysis((payload as { messages: HistoryMessage[] }).messages))
  }, async () => '')
  const preview = await manager.handle(fakeAgent, { op: 'preview', filename: 'long.json', text: json('X'.repeat(19000)), format: 'json' }, signal())
  const ids = preview.conversations.map(c => c.id)
  await assert.rejects(manager.handle(fakeAgent, { op: 'analyze', batchId: preview.batchId, conversationIds: ids }, signal()), /interrupted/)
  assert.equal((await store.readArtifact('imports', preview.batchId, batchSchema))!.conversations[0].parts.length, 1)
  await manager.handle(fakeAgent, { op: 'analyze', batchId: preview.batchId, conversationIds: ids }, signal())
  const checkpointCalls = calls
  await manager.handle(fakeAgent, { op: 'analyze', batchId: preview.batchId, conversationIds: ids }, signal())
  assert.equal(calls, checkpointCalls)
  const other = { ...fakeAgent, options: { provider: 'fake', model: 'changed' } } as unknown as Agent
  await manager.handle(other, { op: 'analyze', batchId: preview.batchId, conversationIds: ids }, signal())
  assert.ok(calls > checkpointCalls)
  assert.ok(chunks([{ id: 'huge', role: 'user', at: null, text: '"\\'.repeat(20000) }], 10000).every(c => JSON.stringify(c).length <= 10000))
})

test('invalid apply preflights every selected branch before creating a persona', async t => {
  const { store } = await fixture(t)
  const manager = new ImportManager(store, configSchema.parse({}), async () => '', async () => '')
  const preview = await manager.handle(fakeAgent, { op: 'preview', filename: 'x', text: json(), format: 'json' }, signal())
  await assert.rejects(manager.handle(fakeAgent, { op: 'apply', batchId: preview.batchId, conversationIds: [preview.conversations[0].id], personaId: 'not-created', newPersona: { id: 'not-created', name: 'a', description: '', prompt: 'b' } }, signal()), /尚未完成/)
  assert.ok(!(await store.listPersonas()).some(p => p.id === 'not-created'))
})

test('project imports bind to each chosen project and preserve surrounding hypothetical evidence', async t => {
  const { store } = await fixture(t)
  const manager = new ImportManager(store, configSchema.parse({}), async (_a, _s, payload) => { const a = analysis((payload as { messages: HistoryMessage[] }).messages); a.proposals.forEach(p => { p.scope = 'project' }); return JSON.stringify(a) }, async () => '')
  const preview = await manager.handle(fakeAgent, { op: 'preview', filename: 'x.json', text: json(), format: 'json' }, signal())
  const conversationIds = preview.conversations.map(c => c.id)
  await manager.handle(fakeAgent, { op: 'analyze', batchId: preview.batchId, conversationIds }, signal())
  const request = { op: 'apply' as const, batchId: preview.batchId, conversationIds, personaId: 'research-mentor' }
  await manager.handle(fakeAgent, request, signal())
  const other = { ...fakeAgent, session: { ...fakeAgent.session, header: { cwd: join(process.cwd(), 'other-project') } } } as unknown as Agent
  await manager.handle(other, request, signal())
  const candidates = (await store.journal()).candidates
  assert.equal(candidates.length, 2); assert.notEqual(candidates[0].projectId, candidates[1].projectId)
  const withoutProject = await manager.handle({ provider: 'fake', model: 'fake', projectId: null }, request, signal())
  assert.match(withoutProject.warnings.join(' '), /未选择项目/)
  assert.equal((await store.journal()).candidates.length, 2, 'project preferences never become cross-project preferences')
  const hypothetical = await manager.handle(fakeAgent, { op: 'preview', filename: 'quoted.json', text: json('假设以后先给结论'), format: 'json' }, signal())
  const ids = hypothetical.conversations.map(c => c.id)
  await manager.handle(fakeAgent, { op: 'analyze', batchId: hypothetical.batchId, conversationIds: ids }, signal())
  // Same source IDs are already processed; also use a different persona to prove context filtering.
  await manager.handle(fakeAgent, { op: 'apply', batchId: hypothetical.batchId, conversationIds: ids, personaId: 'daily-companion' }, signal())
  assert.equal((await store.journal()).candidates.filter(c => c.personaId === 'daily-companion').length, 0)
})

test('cancellation rejects late model output before it can write an analysis checkpoint', async t => {
  const { store } = await fixture(t); const controller = new AbortController()
  const manager = new ImportManager(store, configSchema.parse({}), async () => { controller.abort(); return JSON.stringify(analysis([])) }, async () => '')
  const preview = await manager.handle(fakeAgent, { op: 'preview', filename: 'x', text: json(), format: 'json' }, signal())
  await assert.rejects(manager.handle(fakeAgent, { op: 'analyze', batchId: preview.batchId, conversationIds: preview.conversations.map(c => c.id) }, controller.signal), /abort/i)
  const saved = await store.readArtifact('imports', preview.batchId, batchSchema)
  assert.equal(saved!.conversations[0].parts.length, 0); assert.equal(saved!.conversations[0].analysis, null)
})

test('model stream finish states distinguish provider errors, truncation, empty reasoning and incomplete streams', async () => {
  async function* stream(...chunks: StreamChunk[]) { yield* chunks }
  const finish = { type: 'finish', reason: { kind: 'stop' } } as const
  await assert.rejects(readImportOutput(stream({ type: 'finish', reason: { kind: 'error', failure: { message: 'secret-provider-key', code: 'REQUEST_FAILED', status: 401 } } }), signal()), error => {
    assert.match(String(error), /模型请求失败.*401/); assert.doesNotMatch(String(error), /secret-provider-key|JSON/); return true
  })
  await assert.rejects(readImportOutput(stream({ type: 'text-delta', index: 0, text: '{"summary":' }, { type: 'finish', reason: { kind: 'max-tokens' } }), signal()), error => error instanceof ImportOutputError && error.kind === 'truncated')
  await assert.rejects(readImportOutput(stream({ type: 'reasoning-delta', index: 0, text: 'private reasoning' }, finish), signal()), error => error instanceof ImportOutputError && error.kind === 'empty')
  await assert.rejects(readImportOutput(stream({ type: 'text-delta', index: 0, text: '{}' }), signal()), error => error instanceof ImportOutputError && error.kind === 'incomplete')
  assert.equal(await readImportOutput(stream({ type: 'text-delta', index: 1, text: '{' }, { type: 'block-end', index: 1, block: { type: 'text', text: '{}' } }, finish), signal()), '{}', 'assembled blocks replace partial deltas without duplication')
  await assert.rejects(readImportOutput(stream({ type: 'block-end', index: 0, block: { type: 'text', text: 'x'.repeat(64001) } }, finish), signal()), /超过/)
})

test('invalid model JSON retries once without persisting broken output and reuses completed checkpoints', async t => {
  const { store } = await fixture(t); const attempts: number[] = []
  const manager = new ImportManager(store, configSchema.parse({}), async (_a, _s, _p, _signal, attempt) => {
    attempts.push(attempt!); return attempt === 0 ? '{"summary":' : '\n```json\n' + JSON.stringify(analysis([])) + '\n```\n'
  }, async () => '')
  const preview = await manager.handle(fakeAgent, { op: 'preview', filename: 'broken.json', text: json(), format: 'json' }, signal())
  const request = { op: 'analyze' as const, batchId: preview.batchId, conversationIds: [preview.conversations[0].id] }
  const result = await manager.handle(fakeAgent, request, signal())
  assert.ok(result.conversations[0].analysis); assert.deepEqual(attempts, [0, 1])
  await manager.handle(fakeAgent, request, signal()); assert.deepEqual(attempts, [0, 1])
  assert.equal((await store.readArtifact('imports', preview.batchId, batchSchema))!.conversations[0].parts.length, 1)
})

test('repeated empty responses report a bounded diagnostic while retaining all imported text', async t => {
  const { store } = await fixture(t); let calls = 0
  const manager = new ImportManager(store, configSchema.parse({}), async () => { calls++; return '' }, async () => '')
  const preview = await manager.handle(fakeAgent, { op: 'preview', filename: 'empty.json', text: json(), format: 'json' }, signal())
  await assert.rejects(manager.handle(fakeAgent, { op: 'analyze', batchId: preview.batchId, conversationIds: [preview.conversations[0].id] }, signal()), /未返回提取正文.*自动重试一次/)
  assert.equal(calls, 2)
  const saved = await store.readArtifact('imports', preview.batchId, batchSchema)
  assert.equal(saved!.conversations[0].analysis, null); assert.equal(saved!.conversations[0].parts.length, 0)
  assert.equal(saved!.conversations[0].messages[0].text, '以后先给结论')
})


test('analysis parser accepts presentation wrappers and distinguishes syntax from schema without exposing content', async () => {
  const { parseImportAnalysis } = await import('../src/import-analysis.ts')
  const expected = analysis([]), json = JSON.stringify(expected)
  for (const text of [json, '\uFEFF' + json, '```JSON\n' + json + '\n```', 'Result:\n' + json + '\nEnd.']) assert.deepEqual(parseImportAnalysis(text), expected)
  const braces = { ...expected, summary: 'literal } { and \"quoted\" and backslash \\' }
  assert.deepEqual(parseImportAnalysis('Answer:\n' + JSON.stringify(braces)), braces)
  for (const text of [json + json, '{"summary":', '{"summary":"secret-value",}', '```json\n{"summary":']) assert.throws(() => parseImportAnalysis(text), e => e instanceof ImportOutputError && e.kind === 'format' && !e.message.includes('secret-value'))
  assert.throws(() => parseImportAnalysis(JSON.stringify({ ...expected, topic: 'private-secret' })), e => e instanceof ImportOutputError && e.kind === 'schema' && /topic/.test(e.message) && !e.message.includes('private-secret'))
  assert.throws(() => parseImportAnalysis('{}'), e => e instanceof ImportOutputError && e.kind === 'schema')
})

test('schema retry receives field-specific feedback and output contract contains valid JSON examples', async t => {
  const { store } = await fixture(t); let retrySystem = ''
  const manager = new ImportManager(store, configSchema.parse({}), async (_a, system, _p, _signal, attempt) => {
    if (attempt === 0) return JSON.stringify({ ...analysis([]), topic: 'PRIVATE-UNKNOWN-TOPIC' })
    retrySystem = system; return JSON.stringify(analysis([]))
  }, async () => '')
  const preview = await manager.handle(fakeAgent, { op: 'preview', filename: 'schema.json', text: json(), format: 'json' }, signal())
  const result = await manager.handle(fakeAgent, { op: 'analyze', batchId: preview.batchId, conversationIds: [preview.conversations[0].id] }, signal())
  assert.ok(result.conversations[0].analysisReady)
  assert.match(retrySystem, /Fix these schema fields: topic/); assert.doesNotMatch(retrySystem, /PRIVATE-UNKNOWN-TOPIC/)
  const example = /Example with no reliable memories: (.*)\.\n/.exec(retrySystem)![1]
  assert.ok(JSON.parse(example).personaDraft)
})
