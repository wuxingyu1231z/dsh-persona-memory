import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryStore, recall } from '../src/store.ts'
import { LearningWorker } from '../src/learning.ts'
import { configSchema, type LearningJob, type Proposal } from '../src/schema.ts'

const config = configSchema.parse({ learningMaxAttempts: 1 })
const proposal: Proposal = { key: '回答结构', content: '先给结论再解释', category: 'preference', scope: 'persona', intent: 'explicit', evidence: '以后先给结论再解释', messageId: 'm1', targetId: null }
function job(id: string, text = '以后先给结论再解释', observedAt = Date.now()): LearningJob {
  return { id, personaId: 'research-mentor', projectId: 'project-a', sessionId: 's1', messages: [{ sessionId: 's1', messageId: id, text, observedAt }], provider: 'fake', model: 'fake', mode: 'auto', status: 'pending', attempts: 0, owner: null, leaseUntil: 0, nextAttemptAt: 0, lastError: null, createdAt: observedAt }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = join(process.cwd(), '.test-output'); await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'learning-')); t.after(() => { assert.ok(root.startsWith(base)); return rm(root, { recursive: true, force: true }) })
  const store = new MemoryStore(root); await store.initialize()
  return { store, root }
}
function worker(store: MemoryStore, transform: (j: LearningJob) => Proposal[] = j => [{ ...proposal, messageId: j.messages[0].messageId }]) {
  return new LearningWorker(store, config, async j => JSON.stringify({ proposals: transform(j) }), async () => {})
}
test('explicit learning persists once across restarts and deduplicates source evidence', async t => {
  const { store, root } = await fixture(t)
  const w = worker(store); await w.enqueue([job('m1')]); await w.kick(); await w.stop()
  const restarted = new MemoryStore(root)
  const again = worker(restarted); await again.enqueue([job('m1')]); await again.kick(); await again.stop()
  const memories = await restarted.memories('research-mentor')
  assert.equal(memories.length, 1); assert.equal(memories[0].source.kind, 'learned'); assert.equal(memories[0].revision, 1)
  assert.equal((await store.journal()).jobs[0].messages.length, 0)
})
test('model-selected inferred preferences are saved immediately and duplicate jobs do not add memories', async t => {
  const { store } = await fixture(t)
  const w = worker(store, j => [{ ...proposal, intent: 'inferred', evidence: '给结论', messageId: j.messages[0].messageId }])
  await w.enqueue([job('one', '给结论')]); await w.kick()
  assert.equal((await store.memories('research-mentor')).length, 1)
  const candidate = (await store.journal()).candidates[0]
  assert.equal(candidate.sources.length, 1)
  await w.enqueue([job('one', '给结论'), job('two', '给结论'), job('three', '给结论')]); await w.kick(); await w.stop()
  assert.equal((await store.memories('research-mentor')).length, 1)
})
test('quoted, temporary and unsupported evidence never becomes memory', async t => {
  const { store } = await fixture(t)
  const w = worker(store, j => [{ ...proposal, evidence: j.id === 'fabricated' ? '不存在的原话' : j.messages[0].text, messageId: j.id }])
  await w.enqueue([job('quoted', '假设我喜欢先给结论'), job('temporary', '这次先给结论'), job('fabricated')]); await w.kick(); await w.stop()
  assert.equal((await store.memories('research-mentor')).length, 0)
  assert.equal((await store.journal()).candidates.length, 0)
})
test('locked and stale proposals are skipped automatically; a current correction updates unlocked memory', async t => {
  const { store } = await fixture(t)
  const existing = await store.remember({ personaId: 'research-mentor', projectId: null, key: proposal.key, content: '详细说明', category: 'preference', pinned: true }, 0, { kind: 'user' })
  await store.configureMemory(existing.personaId, existing.id, 1, true, null)
  const w = worker(store)
  await w.enqueue([job('locked', undefined, Date.now() + 100)]); await w.kick()
  const candidate = (await store.journal()).candidates[0]
  assert.equal(candidate.reason, 'locked')
  assert.equal(candidate.status, 'rejected')
  await store.configureMemory(existing.personaId, existing.id, 2, false, null)
  await w.enqueue([job('old', undefined, Date.now() - 10000)]); await w.kick()
  assert.equal((await store.memories(existing.personaId))[0].content, '详细说明')
  await w.enqueue([job('newest', undefined, Date.now() + 1000)]); await w.kick(); await w.stop()
  assert.equal((await store.memories(existing.personaId))[0].content, proposal.content)
})
test('forget fences delayed jobs and rejected candidates cannot be relearned from the same source', async t => {
  const { store } = await fixture(t)
  const w = worker(store); await w.enqueue([job('first', undefined, Date.now() - 10)]); await w.kick()
  const memory = (await store.memories('research-mentor'))[0]
  await store.forget(memory.personaId, memory.id, memory.revision)
  await w.enqueue([job('late', undefined, Date.now() - 10000)]); await w.kick(); await w.stop()
  assert.equal(recall(await store.memories(memory.personaId), memory.personaId, null, '结论', 8).length, 0)
  assert.equal((await store.journal()).candidates.filter(c => c.status === 'pending').length, 0)
})
test('malformed results fail visibly, retain a retryable payload and recover after restart', async t => {
  const { store, root } = await fixture(t)
  const broken = new LearningWorker(store, config, async () => 'not JSON', async () => {})
  await broken.enqueue([job('retry')]); await broken.kick(); await broken.stop()
  let item = (await store.journal()).jobs[0]
  assert.equal(item.status, 'failed'); assert.equal(item.lastError, '学习结果格式无效'); assert.equal(item.messages.length, 1)
  await store.updateJournal(j => { j.jobs[0].status = 'pending'; j.jobs[0].attempts = 0; j.jobs[0].nextAttemptAt = 0 })
  const resumed = worker(new MemoryStore(root)); await resumed.kick(); await resumed.stop()
  item = (await store.journal()).jobs[0]; assert.equal(item.status, 'complete')
})
test('competing workers process one job once; expired leases are reclaimed', async t => {
  const { store, root } = await fixture(t)
  let calls = 0
  const extract = async (j: LearningJob) => { calls++; return JSON.stringify({ proposals: [{ ...proposal, messageId: j.messages[0].messageId }] }) }
  const a = new LearningWorker(store, config, extract, async () => {})
  const b = new LearningWorker(new MemoryStore(root), config, extract, async () => {})
  await a.enqueue([{ ...job('lease'), status: 'running', owner: 'dead', leaseUntil: 0 }]); await Promise.all([a.kick(), b.kick()]); await a.stop(); await b.stop()
  assert.equal(calls, 1); assert.equal((await store.memories('research-mentor')).length, 1)
})
test('per-persona pause prevents queued learning without affecting other personas', async t => {
  const { store } = await fixture(t)
  await store.updateJournal(j => { j.modes['research-mentor'] = 'off' })
  const w = worker(store); await w.enqueue([job('paused'), { ...job('other'), personaId: 'daily-companion' }]); await w.kick(); await w.kick(); await w.stop()
  assert.equal((await store.memories('research-mentor')).length, 0)
  assert.equal((await store.memories('daily-companion')).length, 1)
})
test('expiry excludes a memory from recall while retaining its history', async t => {
  const { store } = await fixture(t)
  const memory = await store.remember({ personaId: 'research-mentor', projectId: null, key: '进度', content: '本周实验', category: 'fact', pinned: true }, 0, { kind: 'user' })
  await store.configureMemory(memory.personaId, memory.id, memory.revision, false, '2000-01-01T00:00:00.000Z')
  assert.equal(recall(await store.memories(memory.personaId), memory.personaId, null, '实验', 8).length, 0)
  assert.equal((await store.memories(memory.personaId))[0].content, '本周实验')
})
test('a newer model-selected preference automatically replaces the earlier preference', async t => {
  const { store } = await fixture(t)
  const current = await store.remember({ personaId: 'research-mentor', projectId: null, key: proposal.key, content: '详细说明', category: 'preference', pinned: true }, 0, { kind: 'user' })
  const w = worker(store, j => [{ ...proposal, evidence: '我喜欢先给结论', messageId: j.messages[0].messageId }])
  await w.enqueue([job('conflict', '我喜欢先给结论', Date.now() + 100)]); await w.kick(); await w.stop()
  assert.equal((await store.memories(current.personaId))[0].content, proposal.content)
  const c = (await store.journal()).candidates[0]; assert.equal(c.reason, 'conflict'); assert.equal(c.status, 'accepted')
  assert.equal((await store.journal()).candidates.filter(c => c.status === 'pending').length, 0)
})
test('explicit-only mode ignores inferred habits; automatic mode saves them and forgetting remains effective', async t => {
  const { store } = await fixture(t)
  await store.updateJournal(j => { j.modes['research-mentor'] = 'explicit' })
  const w = worker(store, j => [{ ...proposal, intent: 'inferred', evidence: '先给结论', messageId: j.messages[0].messageId }])
  await w.enqueue([job('explicit-mode', '先给结论')]); await w.kick()
  assert.equal((await store.journal()).candidates.length, 0)
  await store.updateJournal(j => { j.modes['research-mentor'] = 'auto' })
  await w.enqueue([job('review', '先给结论')]); await w.kick()
  const memory = (await store.memories('research-mentor'))[0]; assert.ok(memory); await store.forget(memory.personaId, memory.id, memory.revision)
  await store.updateJournal(j => { const original = j.jobs.find(x => x.id === 'review')!; original.status = 'pending'; original.attempts = 0; original.messages = job('review', '先给结论', original.createdAt).messages })
  await w.kick(); await w.stop()
  assert.equal((await store.journal()).candidates.filter(c => c.status === 'pending').length, 0)
  assert.ok((await store.memories('research-mentor')).every(m => m.status === 'forgotten'))
})

test('legacy pending memories are resolved once on upgrade, preserving locked and newer content', async t => {
  const { store, root } = await fixture(t)
  const locked = await store.remember({ personaId: 'research-mentor', projectId: null, key: 'locked', content: '人工锁定', category: 'preference', pinned: false }, 0, { kind: 'user' })
  await store.configureMemory(locked.personaId, locked.id, locked.revision, true, null)
  await store.remember({ personaId: 'research-mentor', projectId: null, key: 'old', content: '新的偏好', category: 'preference', pinned: false }, 0, { kind: 'user' })
  await store.updateJournal(journal => {
    for (const [key, at] of [['legacy-new', Date.now()], ['locked', Date.now() + 1000], ['old', 0]] as const) journal.candidates.push({
      id: key, revision: 1, personaId: 'research-mentor', projectId: null,
      proposal: { ...proposal, key, content: '模型提取的偏好', intent: 'inferred' }, sources: [{ ...job(key).messages[0], observedAt: at }],
      status: 'pending', reason: 'inferred', targetId: null, baseRevision: 0, updatedAt: new Date().toISOString(), origin: 'learned',
    })
  })
  await store.settlePending(config)
  const memories = await store.memories('research-mentor')
  assert.equal(memories.find(m => m.key === 'legacy-new')!.content, '模型提取的偏好')
  assert.equal(memories.find(m => m.key === 'locked')!.content, '人工锁定')
  assert.equal(memories.find(m => m.key === 'old')!.content, '新的偏好')
  assert.deepEqual((await store.journal()).candidates.map(c => c.status), ['accepted', 'rejected', 'rejected'])
  await new MemoryStore(root).settlePending(config)
  assert.deepEqual(await store.memories('research-mentor'), memories)
})

test('conflict resolution uses original evidence dates and refreshes confirmations without duplicate memories', async t => {
  const { store } = await fixture(t)
  await store.remember({ personaId: 'research-mentor', projectId: null, key: proposal.key, content: '旧偏好', category: 'preference', pinned: false }, 0, { kind: 'learned', observedAt: 1000 })
  const w = worker(store, j => [{ ...proposal, content: j.id === 'older' ? '过时偏好' : '新的偏好', messageId: j.messages[0].messageId }])
  await w.enqueue([job('newer', undefined, 2000)]); await w.kick()
  await w.enqueue([job('confirmation', undefined, 3000)]); await w.kick()
  await w.enqueue([job('older', undefined, 2500)]); await w.kick(); await w.stop()
  const memories = await store.memories('research-mentor')
  assert.equal(memories.length, 1); assert.equal(memories[0].content, '新的偏好'); assert.equal(memories[0].source.observedAt, 3000)
  assert.equal(memories[0].pinned, false)
  assert.equal((await store.journal()).candidates.at(-1)!.status, 'rejected')
})
test('unload cancellation prevents late writes and returns owned work to a retryable state', async t => {
  const { store } = await fixture(t)
  const started = Promise.withResolvers<void>()
  const w = new LearningWorker(store, configSchema.parse({ learningMaxAttempts: 3 }), async (_job, signal) => {
    started.resolve()
    return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }, async () => {})
  await w.enqueue([job('cancel')]); const running = w.kick(); await started.promise; await w.stop(); await running
  assert.equal((await store.memories('research-mentor')).length, 0)
  const item = (await store.journal()).jobs[0]; assert.equal(item.status, 'pending'); assert.equal(item.owner, null)
})
