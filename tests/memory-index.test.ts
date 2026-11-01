import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { MemoryStore } from '../src/store.ts'
import type { Memory } from '../src/schema.ts'

class TracedStore extends MemoryStore {
  reads: string[] = []
  protected override async readMemoryFile(path: string): Promise<Memory> { this.reads.push(path); return super.readMemoryFile(path) }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = join(process.cwd(), '.test-output'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'indexed-memory-'))
  t.after(async () => { assert.ok(root.startsWith(base)); await rm(root, { recursive: true, force: true }) })
  const store = new TracedStore(root); await store.initialize(); return { root, store }
}
const input = { personaId: 'research-mentor', projectId: null, key: '写作偏好', content: '先给结论', category: 'preference', pinned: false } as const
function markdown(memory: Memory): string { const { content, ...metadata } = memory; return `---\n${dump(metadata)}---\n\n${content}\n` }

test('writes scoped directories and bounded readable indexes without leaking project facts into PROFILE', async t => {
  const { root, store } = await fixture(t)
  const global = await store.remember(input, 0, { kind: 'user' })
  const a = await store.remember({ ...input, projectId: 'project-a', content: 'PROJECT-A-PRIVATE' }, 0, { kind: 'user' })
  await store.remember({ ...input, projectId: 'project-b', content: 'PROJECT-B-PRIVATE' }, 0, { kind: 'user' })
  const persona = join(root, 'personas', input.personaId)
  assert.match(await readFile(join(persona, 'projects/project-a/memories', a.id + '.md'), 'utf8'), /PROJECT-A-PRIVATE/)
  const index = await readFile(join(persona, 'MEMORY.md'), 'utf8'), profile = await readFile(join(persona, 'PROFILE.md'), 'utf8')
  assert.match(index, new RegExp(`memories/${global.id}\\.md`)); assert.match(index, /projects\/project-a\/SUMMARY\.md/)
  assert.match(profile, /先给结论/); assert.doesNotMatch(profile, /PROJECT-[AB]-PRIVATE/)
  const summary = await readFile(join(persona, 'projects/project-a/SUMMARY.md'), 'utf8')
  assert.match(summary, /PROJECT-A-PRIVATE/); assert.doesNotMatch(summary, /PROJECT-B-PRIVATE/)
  assert.ok(index.length <= 12000 && index.split('\n').length <= 129)
})

test('migrates flat project files idempotently and refuses conflicting copies without overwriting either', async t => {
  const { root, store } = await fixture(t)
  const memory = await store.remember({ ...input, projectId: 'project-a' }, 0, { kind: 'user' })
  const persona = join(root, 'personas', input.personaId), flat = join(persona, 'memories', memory.id + '.md'), nested = join(persona, 'projects/project-a/memories', memory.id + '.md')
  await mkdir(join(persona, 'memories'), { recursive: true }); await rename(nested, flat); await unlink(join(root, 'state/layout.json'))
  await new MemoryStore(root).initialize(); await new MemoryStore(root).initialize()
  assert.equal((await store.memories(input.personaId)).length, 1); await assert.rejects(readFile(flat), /ENOENT/)
  await writeFile(flat, markdown({ ...memory, content: '旧平铺副本' })); await unlink(join(root, 'state/layout.json'))
  await assert.rejects(new MemoryStore(root).initialize(), /迁移冲突/)
  assert.match(await readFile(flat, 'utf8'), /旧平铺副本/); assert.doesNotMatch(await readFile(nested, 'utf8'), /旧平铺副本/)
  await writeFile(join(root, 'state/layout.json'), '{"version":999}')
  await assert.rejects(new MemoryStore(root).initialize(), /不支持/)
  assert.match(await readFile(flat, 'utf8'), /旧平铺副本/)
})

test('index rebuild and forgetting remove content from summaries, previews and term caches', async t => {
  const { root, store } = await fixture(t)
  const memory = await store.remember({ ...input, projectId: 'project-a', content: 'sensitive_unique_fact' }, 0, { kind: 'user' })
  const persona = join(root, 'personas', input.personaId), path = join(persona, 'projects/project-a/memories', memory.id + '.md')
  await writeFile(path, markdown({ ...memory, content: 'edited_unique_fact' })); await store.synchronize(input.personaId)
  assert.equal((await store.search(input.personaId, 'project-a', 'edited_unique_fact', 3)).length, 1)
  await store.forget(input.personaId, memory.id, memory.revision)
  for (const path of [join(persona, 'MEMORY.md'), join(persona, 'PROFILE.md'), join(persona, 'projects/project-a/SUMMARY.md'), join(root, 'state/catalogs', input.personaId + '.json')]) assert.doesNotMatch(await readFile(path, 'utf8'), /edited_unique_fact|sensitive_unique_fact/)
  const another = await store.remember({ ...input, projectId: 'project-b', content: 'removed_file_fact' }, 0, { kind: 'user' })
  await unlink(join(persona, 'projects/project-b/memories', another.id + '.md')); await store.synchronize(input.personaId)
  assert.doesNotMatch(await readFile(join(persona, 'projects/project-b/SUMMARY.md'), 'utf8'), /removed_file_fact/)
  await writeFile(join(root, 'state/catalogs', input.personaId + '.json'), 'broken cache')
  await unlink(join(persona, 'PROFILE.md')); await unlink(join(persona, 'MEMORY.md'))
  await new MemoryStore(root).initialize()
  assert.match(await readFile(join(persona, 'MEMORY.md'), 'utf8'), /记忆索引/)
  assert.doesNotMatch(await readFile(join(persona, 'PROFILE.md'), 'utf8'), /edited_unique_fact|sensitive_unique_fact|removed_file_fact/)
})

test('one thousand memories use cached terms and read only matching bodies after restart', async t => {
  const { root, store } = await fixture(t)
  const sample = await store.remember(input, 0, { kind: 'user' })
  const folder = join(root, 'personas', input.personaId, 'memories')
  for (let start = 0; start < 1000; start += 50) await Promise.all(Array.from({ length: 50 }, (_, n) => start + n).map(i => writeFile(join(folder, `entry-${i}.md`), markdown({ ...sample, id: `entry-${i}`, key: `topic-${i}`, content: 'ordinary detail '.repeat(40) + (i === 777 ? 'needleomega' : 'unrelated') }))))
  await store.synchronize(input.personaId)
  const restarted = new TracedStore(root); await restarted.initialize(); assert.equal(restarted.reads.length, 0, 'warm restart must not read every Markdown body')
  restarted.reads = []
  const result = await restarted.search(input.personaId, null, 'needleomega', 3)
  assert.equal(result.length, 1); assert.equal(result[0].id, 'entry-777'); assert.equal(restarted.reads.length, 1)
  const index = await readFile(join(root, 'personas', input.personaId, 'MEMORY.md'), 'utf8')
  assert.ok(index.length <= 12000 && index.split('\n').length <= 129); assert.equal(index.includes('ordinary detail '.repeat(15)), false)
})

test('lazy reads preserve a captured revision and cannot revive forgotten details', async t => {
  const { store } = await fixture(t)
  const first = await store.remember(input, 0, { kind: 'user' }), snapshot = await store.index(input.personaId)
  await store.remember({ ...input, content: '后来纠正的偏好' }, first.revision, { kind: 'user' })
  assert.equal((await store.search(input.personaId, null, '结论', 1, snapshot))[0].content, input.content)
  await store.forget(input.personaId, first.id, 2)
  assert.equal((await store.search(input.personaId, null, '结论', 1, snapshot)).length, 0)
})

test('an actual query match ranks ahead of unrelated pinned memories', async t => {
  const { store } = await fixture(t)
  await store.remember({ ...input, key: '无关的重要偏好', content: '喝咖啡', pinned: true }, 0, { kind: 'user' })
  const wanted = await store.remember({ ...input, key: '实验', content: 'needleomega 的实验结果' }, 0, { kind: 'user' })
  assert.equal((await store.search(input.personaId, null, 'needleomega', 1))[0].id, wanted.id)
})
