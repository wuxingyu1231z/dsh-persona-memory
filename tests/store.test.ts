import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, rm, mkdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryStore, recall, projectId } from '../src/store.ts'
import { requestSchema } from '../src/schema.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = join(process.cwd(), '.test-output')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'store-'))
  t.after(() => { assert.ok(root.startsWith(base)); return rm(root, { recursive: true, force: true }) })
  const store = new MemoryStore(root)
  await store.initialize()
  return { root, store }
}
const preference = { personaId: 'research-mentor', projectId: null, key: '写作习惯', content: '论文先给结论，再给实验依据', category: 'preference', pinned: true } as const

test('persists personas, selected persona and Markdown memories across restarts', async t => {
  const { root, store } = await fixture(t)
  assert.equal((await store.listPersonas()).length, 3)
  const saved = await store.remember(preference, 0, { kind: 'user', sessionId: 'one' })
  await store.select('one', 'coding-partner')
  const restarted = new MemoryStore(root)
  await restarted.initialize()
  assert.equal(await restarted.selection('one', 'research-mentor'), 'coding-partner')
  assert.equal((await restarted.memories('research-mentor'))[0].content, preference.content)
  assert.match(await readFile(join(root, 'personas', preference.personaId, 'memories', `${saved.id}.md`), 'utf8'), /category: preference/)
})
test('Chinese recall isolates both persona and project before ranking', async t => {
  const { store } = await fixture(t)
  await store.remember(preference, 0, { kind: 'user' })
  await store.remember({ ...preference, personaId: 'coding-partner' }, 0, { kind: 'user' })
  await store.remember({ ...preference, key: '论文项目', projectId: 'project-a', pinned: false }, 0, { kind: 'user' })
  const all = await store.memories('research-mentor')
  assert.equal(recall(all, 'research-mentor', 'project-b', '论文', 8).length, 1)
  assert.equal(recall(all, 'coding-partner', 'project-a', '论文', 8).length, 0)
  assert.equal(recall(all, 'research-mentor', 'project-a', '论文', 8).length, 2)
})
test('concurrent writers serialize and reject stale revisions', async t => {
  const { root, store } = await fixture(t)
  const other = new MemoryStore(root)
  const outcomes = await Promise.allSettled([store.remember(preference, 0, { kind: 'user' }), other.remember(preference, 0, { kind: 'user' })])
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal((await store.memories(preference.personaId)).length, 1)
  const next = await store.remember({ ...preference, content: '以后先简短回答' }, 1, { kind: 'user' })
  assert.equal(next.revision, 2)
  assert.equal((await store.memories(preference.personaId))[0].content, '以后先简短回答')
  const revisions = await readdir(join(root, 'personas', preference.personaId, 'revisions'))
  assert.equal(revisions.length, 1)
})
test('forget removes content and evidence from active files and old revisions', async t => {
  const { root, store } = await fixture(t)
  const first = await store.remember(preference, 0, { kind: 'user', evidence: 'private-evidence' })
  await store.remember({ ...preference, content: 'private-content' }, 1, { kind: 'user', evidence: 'private-evidence' })
  await store.forget(first.personaId, first.id, 2)
  assert.equal(recall(await store.memories(first.personaId), first.personaId, null, 'private', 8).length, 0)
  const contents = await readFile(join(root, 'personas', first.personaId, 'memories', `${first.id}.md`), 'utf8')
  assert.doesNotMatch(contents, /private-evidence|private-content/)
  assert.equal((await readdir(join(root, 'personas', first.personaId, 'revisions'))).length, 0)
})
test('persona edits use compare-and-set and survive manual Markdown edits', async t => {
  const { root, store } = await fixture(t)
  const current = await store.getPersona('research-mentor')
  await store.savePersona({ id: current.id, name: '我的导师', description: '', prompt: '先讨论实验' }, 1)
  await assert.rejects(store.savePersona({ id: current.id, name: '旧页面', description: '', prompt: '不覆盖' }, 1), /刷新/)
  const path = join(root, 'personas', current.id, 'PERSONA.md')
  await writeFile(path, (await readFile(path, 'utf8')).replace('先讨论实验', '先讨论研究问题'))
  assert.equal((await store.getPersona(current.id)).prompt, '先讨论研究问题')
})
test('rejects path traversal, unknown operations and corrupt ownership', async t => {
  const { root, store } = await fixture(t)
  await assert.rejects(store.getPersona('../escape'))
  assert.equal(requestSchema.safeParse({ op: 'select', personaId: '../escape' }).success, false)
  assert.equal(requestSchema.safeParse({ op: 'snapshot', path: 'secret' }).success, false)
  const saved = await store.remember(preference, 0, { kind: 'user' })
  const path = join(root, 'personas', preference.personaId, 'memories', `${saved.id}.md`)
  await writeFile(path, (await readFile(path, 'utf8')).replace('personaId: research-mentor', 'personaId: coding-partner'))
  await assert.rejects(store.memories(preference.personaId), /归属/)
})
test('project IDs do not expose filesystem paths', () => {
  assert.equal(projectId(undefined), null)
  assert.equal(projectId('/tmp/a'), projectId('/tmp/a'))
  assert.notEqual(projectId('/tmp/a'), projectId('/tmp/b'))
  assert.match(projectId('/tmp/a')!, /^p-[a-f0-9]{24}$/)
})
test('an abandoned stale write lock is recovered on restart', async t => {
  const { root, store } = await fixture(t)
  const lock = join(root, '.writer-lock'); await mkdir(lock)
  const past = new Date(Date.now() - 60000); await utimes(lock, past, past)
  await store.remember(preference, 0, { kind: 'user' })
  assert.equal((await store.memories(preference.personaId)).length, 1)
})
test('separate Node processes share the writer lock and cannot overwrite one topic', async t => {
  const { root } = await fixture(t)
  const worker = join(root, 'writer.mjs')
  await writeFile(worker, `import { MemoryStore } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};\nconst store = new MemoryStore(process.argv[2]);\ntry { await store.remember(${JSON.stringify(preference)}, 0, {kind:'user'}); } catch(error) { if (error.message.includes('刷新')) process.exitCode = 2; else throw error; }\n`)
  const execute = promisify(execFile)
  const results = await Promise.allSettled([execute(process.execPath, ['--import', 'tsx', worker, root]), execute(process.execPath, ['--import', 'tsx', worker, root])])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const failed = results.find(r => r.status === 'rejected')
  assert.ok(failed?.status === 'rejected')
  assert.equal(failed.reason.code, 2)
  assert.equal((await new MemoryStore(root).memories(preference.personaId)).length, 1)
})
