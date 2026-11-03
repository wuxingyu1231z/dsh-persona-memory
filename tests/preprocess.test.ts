import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { preprocessHistory, historyParts } from '../src/preprocess.ts'
import { parseHistory } from '../src/import-parser.ts'
import { ImportManager } from '../src/import-manager.ts'
import { batchSchema } from '../src/import-schema.ts'
import { MemoryStore } from '../src/store.ts'
import { configSchema } from '../src/schema.ts'

const source = { projectId: null }
const signal = () => new AbortController().signal
const chat = (n: number) => ({ id: `chat-${n}`, title: `Conversation ${n}`, messages: [{ id: `u-${n}`, role: 'user', content: `Question ${n}` }, { id: `a-${n}`, role: 'assistant', content: `Answer ${n}` }] })
function branching(count: number, prefix = 1) {
  const mapping: Record<string, { parent: string | null; message: unknown }> = { root: { parent: null, message: null } }
  for (let i = 0; i < prefix; i++) mapping[`u-${i}`] = { parent: i ? `u-${i - 1}` : 'root', message: { id: `user-${i}`, role: 'user', content: `正文 ${i}\n\`\`\`js\nconst x = ${i}\n\`\`\``, create_time: 1700000000 + i } }
  for (let i = 0; i < count; i++) mapping[`a-${i}`] = { parent: `u-${prefix - 1}`, message: { id: `answer-${i}`, fragments: [{ type: 'RESPONSE', content: `分支 ${i} 的完整回复` }], inserted_at: '2025-01-02T00:00:00Z' } }
  return { id: 'many-branches', title: '多分支会话', current_node: `a-${count - 1}`, mapping }
}
const identities = (conversations: ReturnType<typeof parseHistory>['conversations']) => conversations.map(c => [c.id, c.sourceId, c.title, c.branchId, c.platform, c.preferred, c.messages])
const fullLimits = { chars: 4000000, conversations: 1000, branches: 1000, messages: 100000 }
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = join(process.cwd(), '.test-output'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'whole-import-'))
  t.after(() => { assert.ok(root.startsWith(base)); return rm(root, { recursive: true, force: true }) })
  const store = new MemoryStore(root); await store.initialize()
  const manager = new ImportManager(store, configSchema.parse({}), async () => { throw new Error('Import must not call a model') }, async () => { throw new Error('Import must not create a chat') })
  t.after(() => manager.stop())
  return { store, manager }
}

test('preprocessing retains exact DeepSeek visible text, branch identities and timestamps while discarding large tool/thinking payloads', () => {
  const raw = { id: 'deepseek', title: '实验', current_node: 'a2', mapping: {
    root: { parent: null, message: null },
    u: { parent: 'root', message: { id: 'user', inserted_at: '2025-01-02T00:00:00Z', fragments: [{ type: 'REQUEST', content: '  Keep ```code```\n<think>literal user text</think>  ' }, { type: 'FILE', files: ['private.pdf'] }] } },
    tool: { parent: 'u', message: { fragments: [{ type: 'TOOL_OPEN', content: 'huge tool data'.repeat(10000) }] } },
    a: { parent: 'tool', message: { fragments: [{ type: 'THINK', content: 'hidden'.repeat(10000) }, { type: 'RESPONSE', content: 'old\n```ts\nconst x = 1\n```' }] } },
    a2: { parent: 'u', message: { fragments: [{ type: 'RESPONSE', content: 'new answer' }] } },
  } }
  const text = JSON.stringify(raw), before = parseHistory('x.json', text, 'json')
  const prepared = preprocessHistory('x.json', text), [part] = historyParts(prepared)
  const after = parseHistory('x.json', part.text, part.format)
  assert.deepEqual(after.conversations.map(c => [c.id, c.branchId, c.platform, c.preferred, c.messages]), before.conversations.map(c => [c.id, c.branchId, c.platform, c.preferred, c.messages]))
  assert.equal(prepared.conversations[0].branches, 2); assert.equal(prepared.removedFragments, 3)
  assert.equal(prepared.removedThinkingCharacters, 60000)
  assert.doesNotMatch(part.text, /huge tool data|private.pdf|hidden/)
  assert.ok(part.text.length < text.length / 20)
  assert.match(after.warnings.join(' '), /预处理已移除/)
  const again = preprocessHistory('cleaned.json', part.text)
  assert.deepEqual(JSON.parse(again.conversations[0].text), JSON.parse(part.text), 'cleaned files are stable on reimport')
})

test('ChatGPT analysis channels, tool recipients and attachments are removed without changing visible text', () => {
  const raw = { id: 'gpt', mapping: {
    u: { parent: null, message: { id: 'u', author: { role: 'user' }, create_time: 1700000000, content: { content_type: 'multimodal_text', parts: ['question', { image: 'blob' }] } } },
    think: { parent: 'u', message: { author: { role: 'assistant' }, channel: 'analysis', content: { content_type: 'text', parts: ['private reasoning'] } } },
    tool: { parent: 'think', message: { author: { role: 'assistant' }, recipient: 'python', content: 'tool code' } },
    a: { parent: 'tool', message: { id: 'a', author: { role: 'assistant' }, channel: 'final', content: { content_type: 'text', parts: ['  answer\n```text\nhi\n```  '] } } },
  } }
  const prepared = preprocessHistory('chatgpt.json', JSON.stringify(raw))
  const [part] = historyParts(prepared), batch = parseHistory('chatgpt.json', part.text, 'json')
  assert.deepEqual(batch.conversations[0].messages.map(m => m.text), ['question', '  answer\n```text\nhi\n```  '])
  assert.equal(batch.conversations[0].messages[0].at, 1700000000000)
  assert.doesNotMatch(part.text, /private reasoning|tool code|blob/)
})

test('all conversations are automatically partitioned; invalid conversations prevent a silent partial import', () => {
  const prepared = preprocessHistory('all.json', JSON.stringify(Array.from({ length: 307 }, (_, n) => chat(n))))
  const parts = historyParts(prepared)
  assert.equal(prepared.conversations.length, 307); assert.equal(parts.length, 10)
  assert.equal(parts.flatMap(p => parseHistory('all.json', p.text, p.format).conversations).length, 307)
  assert.throws(() => historyParts(preprocessHistory('mixed.json', JSON.stringify([chat(1), { title: 'broken', mapping: { a: { parent: 'missing' } } }]))), /整包未导入.*broken/)
  assert.throws(() => preprocessHistory('user.json', '{"email":"unused"}'), /账户文件/)
  assert.throws(() => preprocessHistory('bad.json', JSON.stringify({ mapping: { a: { parent: 'a' } } })), /循环/)
})

test('one conversation with more than sixteen branches is split automatically without new branches or changing the preferred path', () => {
  for (const current of ['a-72', 'u-0', null]) {
    const raw = { ...branching(73), current_node: current }
    const prepared = preprocessHistory('many.json', JSON.stringify(raw))
    const expected = parseHistory('many.json', prepared.conversations[0].text, 'json', fullLimits)
    const parts = historyParts(prepared)
    const imported = parts.flatMap(part => parseHistory('many.json', part.text, part.format).conversations)
    assert.deepEqual(identities(imported), identities(expected.conversations))
    const fragments = parts.flatMap(part => { const value = JSON.parse(part.text); return Array.isArray(value) ? value : [value] })
    assert.ok(fragments.length > 1)
    assert.ok(fragments.every(c => c.personaMemoryPreprocessing.branchSelection.tips.length <= 16))
    assert.ok(fragments.every(c => Object.keys(c.mapping).length < Object.keys(raw.mapping).length), 'named graphs retain only the selected ancestors')
    assert.equal(imported.filter(c => c.preferred).length, 1)
    assert.match(imported[0].warnings.join(' '), /自动拆批/)
  }
})

test('anonymous split graphs keep stable identities, and preprocessing an already split export does not expand the other branches again', () => {
  const { id, ...raw } = branching(41)
  const prepared = preprocessHistory('anonymous.json', JSON.stringify(raw))
  const expected = parseHistory('anonymous.json', prepared.conversations[0].text, 'json', fullLimits)
  const parts = historyParts(prepared)
  const imported = parts.flatMap(part => parseHistory('anonymous.json', part.text, part.format).conversations)
  assert.deepEqual(identities(imported), identities(expected.conversations))
  const reimported = parts.flatMap(part => historyParts(preprocessHistory('cleaned.json', part.text))).flatMap(part => parseHistory('cleaned.json', part.text, part.format).conversations)
  assert.deepEqual(identities(reimported), identities(imported))
})

test('large shared prefixes split again by expanded message limits, while every branch keeps its full prefix', () => {
  const prepared = preprocessHistory('long.json', JSON.stringify(branching(20, 1300)))
  const parts = historyParts(prepared)
  assert.ok(parts.length >= 2, 'raw JSON size alone does not capture repeated branch prefixes')
  const conversations = parts.flatMap(part => parseHistory('long.json', part.text, part.format).conversations)
  assert.equal(conversations.length, 20)
  for (const conversation of conversations) {
    assert.equal(conversation.messages.length, 1301)
    assert.equal(conversation.messages[0].id, 'user-0')
    assert.equal(conversation.messages[1299].id, 'user-1299')
  }
})

test('branch batches also respect raw graph size and expanded archive size without clipping text', () => {
  for (const repeated of [false, true]) {
    const raw = branching(repeated ? 32 : 6)
    const payload = 'x'.repeat(repeated ? 300000 : 700000)
    if (repeated) raw.mapping['u-0'].message = { id: 'shared-user', role: 'user', content: payload }
    else for (let i = 0; i < 6; i++) raw.mapping[`a-${i}`].message = { id: `answer-${i}`, role: 'assistant', content: payload }
    const prepared = preprocessHistory('large.json', JSON.stringify(raw)), parts = historyParts(prepared)
    assert.ok(parts.length >= 2)
    const records = parts.flatMap(part => {
      assert.ok(part.text.length <= 4000000)
      const parsed = parseHistory('large.json', part.text, part.format)
      assert.ok(JSON.stringify(parsed).length <= 8000000)
      return parsed.conversations
    })
    assert.equal(records.length, repeated ? 32 : 6)
    for (const record of records) assert.equal(record.messages[repeated ? 0 : 1].text, payload)
  }
})

test('empty graph paths do not block import, and forged selections cannot bypass missing-node or cycle checks', () => {
  const raw = branching(1)
  for (let i = 0; i < 25; i++) raw.mapping[`empty-${i}`] = { parent: 'root', message: null }
  const parts = historyParts(preprocessHistory('empty.json', JSON.stringify(raw)))
  assert.equal(parts.flatMap(part => parseHistory('empty.json', part.text, part.format).conversations).length, 1)
  const fragment = JSON.parse(parts[0].text)
  for (const tips of [['missing'], ['a-0', 'a-0']]) assert.throws(() => parseHistory('x', JSON.stringify({ ...fragment, personaMemoryPreprocessing: { ...fragment.personaMemoryPreprocessing, branchSelection: { tips, preferred: 'a-0' } } }), 'json'), /分支分片/)
  fragment.mapping.cycle = { parent: 'cycle', message: null }
  assert.throws(() => parseHistory('x', JSON.stringify(fragment), 'json'), /循环/)
})

test('hundreds of branches from one source commit as a single archive, retaining identities through retries and repeated imports', async t => {
  const { store, manager } = await fixture(t)
  const prepared = preprocessHistory('many.json', JSON.stringify(branching(257))), parts = historyParts(prepared)
  const expected = parseHistory('many.json', prepared.conversations[0].text, 'json', fullLimits)
  assert.ok(parts.length >= 3)
  let batchId = ''
  for (const requestId of ['many-branches', 'many-branches-retry']) {
    const started = await manager.handle(source, { op: 'beginUpload', filename: 'many.json', requestId, parts: parts.length, branches: 257 }, signal())
    for (let index = 0; index < parts.length; index++) {
      const request = { op: 'uploadPart' as const, uploadId: started.batchId, index, ...parts[index] }
      await manager.handle(source, request, signal()); await manager.handle(source, request, signal())
    }
    const complete = await manager.handle(source, { op: 'finishUpload', uploadId: started.batchId }, signal())
    if (batchId) assert.equal(complete.batchId, batchId)
    batchId = complete.batchId
    const archive = (await store.readArtifact('imports', batchId, batchSchema))!
    assert.deepEqual(identities(archive.conversations), identities(expected.conversations))
    assert.equal(complete.page!.conversationId, expected.conversations.find(c => c.preferred)!.id)
  }
  assert.equal((await manager.list()).length, 1)
})

test('whole-file upload commits all 307 conversations together, retries idempotently and removes hidden part files', async t => {
  const { store, manager } = await fixture(t)
  const prepared = preprocessHistory('all.json', JSON.stringify(Array.from({ length: 307 }, (_, n) => chat(n)))), parts = historyParts(prepared)
  const begin = { op: 'beginUpload' as const, filename: 'all.json', requestId: 'whole-export', parts: parts.length, branches: 307 }
  const started = await manager.handle(source, begin, signal())
  assert.equal((await manager.list()).length, 0)
  await assert.rejects(manager.handle(source, { op: 'finishUpload', uploadId: started.batchId }, signal()), /未全部到达/)
  for (let index = 0; index < parts.length; index++) {
    const request = { op: 'uploadPart' as const, uploadId: started.batchId, index, ...parts[index] }
    await manager.handle(source, request, signal()); await manager.handle(source, request, signal())
  }
  await assert.rejects(manager.handle(source, { op: 'uploadPart', uploadId: started.batchId, index: 0, text: JSON.stringify(chat(999)), format: 'json' }, signal()), /内容发生变化/)
  assert.equal((await manager.list()).length, 0, 'no partial archive is exposed')
  const [finished, concurrent] = await Promise.all([manager.handle(source, { op: 'finishUpload', uploadId: started.batchId }, signal()), manager.handle(source, { op: 'finishUpload', uploadId: started.batchId }, signal())])
  assert.equal(finished.batchId, concurrent.batchId); assert.equal(finished.conversations.length, 307)
  const stored = await store.readArtifact('imports', finished.batchId, batchSchema)
  assert.deepEqual(stored!.conversations.map(c => c.sourceId), Array.from({ length: 307 }, (_, n) => `chat-${n}`))
  assert.equal((await manager.list()).length, 1)
  assert.equal((await store.artifactIds('imports')).some(id => id.startsWith('part-')), false)
  assert.equal((await manager.handle(source, begin, signal())).batchId, finished.batchId)
  // A fresh upload of the same export converges on the same final archive.
  const second = await manager.handle(source, { ...begin, requestId: 'retry-file' }, signal())
  for (let index = 0; index < parts.length; index++) await manager.handle(source, { op: 'uploadPart', uploadId: second.batchId, index, ...parts[index] }, signal())
  assert.equal((await manager.handle(source, { op: 'finishUpload', uploadId: second.batchId }, signal())).batchId, finished.batchId)
  assert.equal((await manager.list()).length, 1)
})

test('wrong counts, conflicting branch identities and cancellation leave no partial final archive', async t => {
  const { manager } = await fixture(t)
  const started = await manager.handle(source, { op: 'beginUpload', filename: 'all.json', requestId: 'wrong-count', parts: 1, branches: 2 }, signal())
  await manager.handle(source, { op: 'uploadPart', uploadId: started.batchId, index: 0, text: JSON.stringify(chat(1)), format: 'json' }, signal())
  await assert.rejects(manager.handle(source, { op: 'finishUpload', uploadId: started.batchId }, signal()), /数量不一致/)
  const conflict = await manager.handle(source, { op: 'beginUpload', filename: 'all.json', requestId: 'conflict', parts: 2, branches: 2 }, signal())
  for (let index = 0; index < 2; index++) await manager.handle(source, { op: 'uploadPart', uploadId: conflict.batchId, index, text: JSON.stringify({ ...chat(1), title: `variant-${index}` }), format: 'json' }, signal())
  await assert.rejects(manager.handle(source, { op: 'finishUpload', uploadId: conflict.batchId }, signal()), /内容不同/)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(manager.handle(source, { op: 'finishUpload', uploadId: started.batchId }, aborted.signal), /abort/i)
  assert.equal((await manager.list()).length, 0)
})


test('small UTF-8 upload chunks preserve long Chinese text, resume after a dropped reply and commit atomically', async t => {
  const { uploadChunks } = await import('../src/import-upload.ts')
  const { store, manager } = await fixture(t)
  const content = '中文😀\n\t"\\'.repeat(25000)
  const raw = JSON.stringify({ id: 'large-cn', messages: [{ role: 'user', content }] })
  const texts = uploadChunks(raw)
  assert.equal(texts.join(''), raw); assert.ok(texts.length > 4)
  for (const text of texts) assert.ok(Buffer.byteLength(JSON.stringify(text)) <= 60000)
  const start = await manager.handle(source, { op: 'beginUpload', filename: 'large.json', requestId: 'chunks-test', parts: 1, branches: 1 }, signal())
  const request = (chunk: number) => ({ op: 'uploadChunk' as const, uploadId: start.batchId, index: 0, chunk, total: texts.length, format: 'json' as const, text: texts[chunk] })
  await manager.handle(source, request(0), signal())
  await assert.rejects(manager.handle(source, { ...request(0), text: 'conflicting' }, signal()), /内容发生变化/)
  await assert.rejects(manager.handle(source, request(texts.length - 1), signal()), /缺失/)
  assert.equal((await manager.list()).length, 0)
  for (let i = 0; i < texts.length; i++) { await manager.handle(source, request(i), signal()); await manager.handle(source, request(i), signal()) }
  const result = await manager.handle(source, { op: 'finishUpload', uploadId: start.batchId }, signal())
  const batch = await store.readArtifact('imports', result.batchId, batchSchema)
  assert.equal(batch!.conversations[0].messages[0].text, content)
  assert.equal((await store.artifactIds('imports')).filter(id => id.startsWith('part-')).length, 0)
})

test('incremental extraction checkpoints both segments and reductions; each RPC runs at most one generation', async t => {
  const { store } = await fixture(t)
  let calls = 0
  const generated = new Set<string>()
  const make = () => new ImportManager(store, configSchema.parse({ importInputChars: 12000 }), async (_source, system, payload) => {
    const key = JSON.stringify([system, payload]); assert.ok(!generated.has(key), 'completed model work must survive retries and manager restart')
    generated.add(key); calls++
    return JSON.stringify({ summary: `Summary ${calls}`, personaDraft: { name: '导师', description: '认真', prompt: '指导' }, topic: 'research', proposals: [] })
  }, async () => { throw new Error('must not create a chat') })
  let manager = make(); t.after(() => manager.stop())
  const raw = JSON.stringify({ id: 'incremental', messages: Array.from({ length: 7 }, (_, i) => ({ id: `m-${i}`, role: 'user', content: String(i) + '科研'.repeat(2900) })) })
  const preview = await manager.handle(source, { op: 'preview', filename: 'long.json', text: raw, format: 'json' }, signal())
  let pending = preview.conversations.map(c => c.id), turns = 0
  while (pending.length) {
    const before = calls
    const reply = await manager.handle(source, { op: 'analyze', batchId: preview.batchId, conversationIds: pending, incremental: true }, signal())
    assert.ok(calls - before <= 1)
    pending = reply.pendingAnalysisIds ?? []; assert.ok(++turns < 30)
    if (turns === 3) { await manager.stop(); manager = make() }
    if (!pending.length) assert.equal(reply.conversations[0].analysisReady, true)
  }
  assert.ok(calls > 7, 'multiple segments and merge levels were checkpointed')
  const before = calls
  await manager.handle(source, { op: 'analyze', batchId: preview.batchId, conversationIds: preview.conversations.map(c => c.id), incremental: true }, signal())
  assert.equal(calls, before)
})
