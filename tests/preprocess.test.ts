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
