import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import { SemanticMemory, cosine } from '../src/semantic.ts'
import { configSchema } from '../src/schema.ts'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = join(process.cwd(), '.test-output'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'semantic-'))
  t.after(() => { assert.ok(root.startsWith(base)); return rm(root, { recursive: true, force: true }) })
  const store = new MemoryStore(root); await store.initialize(); return { store, root }
}
const cfg = configSchema.parse({ recallLimit: 2, embedding: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434/api/embed', model: 'test-embed' } })
const signal = () => new AbortController().signal
test('semantic recall finds paraphrases, filters scope before outbound calls and caches vectors', async t => {
  const { store, root } = await fixture(t)
  const save = (personaId: string, projectId: string | null, key: string, content: string) => store.remember({ personaId, projectId, key, content, category: 'preference', pinned: false }, 0, { kind: 'user' })
  const wanted = await save('research-mentor', null, '结构', '先给结论再解释')
  const offTopic = await save('research-mentor', null, '饮料', '喜欢咖啡')
  const other = await save('daily-companion', null, '秘密', 'other persona secret')
  const otherProject = await save('research-mentor', 'project-b', '项目', 'other project secret')
  const expired = await save('research-mentor', null, '过去', 'expired secret')
  await store.configureMemory(expired.personaId, expired.id, 1, false, '2020-01-01T00:00:00Z')
  const inputs: string[][] = []
  const embedding = new SemanticMemory(store, cfg, (async (_url, init) => {
    const body = JSON.parse(init!.body as string); assert.equal(body.truncate, false); inputs.push(body.input)
    return Response.json({ embeddings: body.input.map((s: string) => /结论|简明扼要/.test(s) ? [1, 0] : [0, 1]) })
  }) as typeof fetch)
  const memories = [...await store.memories('research-mentor'), other, otherProject]
  assert.equal((await embedding.search(memories, 'research-mentor', 'project-a', '请简明扼要地回答', signal()))[0].id, wanted.id)
  assert.doesNotMatch(JSON.stringify(inputs), /secret/)
  const initial = inputs.length
  await embedding.search(memories, 'research-mentor', 'project-a', '请简明扼要地回答', signal())
  assert.equal(inputs.length, initial + 1)
  await store.remember({ personaId: wanted.personaId, projectId: null, key: wanted.key, content: '先给结论，然后证据', category: wanted.category, pinned: false }, 1, { kind: 'user' })
  await embedding.search([...await store.memories('research-mentor'), other], 'research-mentor', 'project-a', '简明扼要', signal())
  assert.ok(inputs.flat().some(s => s.includes('然后证据')))
  await store.forget(wanted.personaId, wanted.id, 2); await embedding.forget(wanted.personaId, wanted.id)
  for (const id of await store.artifactIds('semantic')) assert.doesNotMatch(await readFile(join(root, 'semantic', id + '.json'), 'utf8'), new RegExp(wanted.id))
  assert.equal((await embedding.search(await store.memories('research-mentor'), 'research-mentor', 'project-a', '简明扼要', signal())).some(m => m.id === wanted.id), false)
  assert.notEqual(offTopic.id, wanted.id)
})

test('disabled embeddings need no network; malformed vectors fail safely', async t => {
  const { store } = await fixture(t)
  await store.remember({ personaId: 'research-mentor', projectId: null, key: '写作', content: '先列提纲', category: 'preference', pinned: false }, 0, { kind: 'user' })
  const memories = await store.memories('research-mentor')
  const disabled = new SemanticMemory(store, configSchema.parse({}), (async () => { throw new Error('unexpected network') }) as typeof fetch)
  assert.equal((await disabled.search(memories, 'research-mentor', null, '写作', signal())).length, 1)
  const invalid = new SemanticMemory(store, cfg, (async () => Response.json({ embeddings: [[0, 0]] })) as typeof fetch)
  await assert.rejects(invalid.search(memories, 'research-mentor', null, '写作', signal()), /无效/)
  assert.throws(() => cosine([1], [1, 2]), /维度/)
})

test('compatible endpoint uses indexed vectors and an environment credential without persisting the key', async t => {
  const { store, root } = await fixture(t)
  const previous = process.env.PERSONA_EMBED_TEST; process.env.PERSONA_EMBED_TEST = 'local-test-secret'
  t.after(async () => { if (previous === undefined) delete process.env.PERSONA_EMBED_TEST; else process.env.PERSONA_EMBED_TEST = previous })
  await store.remember({ personaId: 'research-mentor', projectId: null, key: '结构', content: '结论优先', category: 'preference', pinned: false }, 0, { kind: 'user' })
  const embed = new SemanticMemory(store, configSchema.parse({ embedding: { provider: 'openai-compatible', endpoint: 'http://localhost/v1/embeddings', model: 'local', apiKeyEnv: 'PERSONA_EMBED_TEST' } }), (async (_url, init) => {
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer local-test-secret')
    const input = JSON.parse(init!.body as string).input
    return Response.json({ data: input.map((_s: string, i: number) => ({ index: i, embedding: [1, 0] })) })
  }) as typeof fetch)
  await embed.search(await store.memories('research-mentor'), 'research-mentor', null, '怎么组织回答', signal())
  for (const id of await store.artifactIds('semantic')) assert.doesNotMatch(await readFile(join(root, 'semantic', id + '.json'), 'utf8'), /local-test-secret/)
})

test('forgetting during a pending embedding cannot recreate the cached vector', async t => {
  const { store, root } = await fixture(t)
  const memory = await store.remember({ personaId: 'research-mentor', projectId: null, key: '私密', content: '不要恢复这条', category: 'fact', pinned: false }, 0, { kind: 'user' })
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); t.after(async () => release.resolve())
  let calls = 0
  const embed = new SemanticMemory(store, cfg, (async () => { if (++calls === 1) { started.resolve(); await release.promise }; return Response.json({ embeddings: [[1, 0]] }) }) as typeof fetch)
  const pending = embed.search(await store.memories(memory.personaId), memory.personaId, null, '同义表达', signal())
  await started.promise; await store.forget(memory.personaId, memory.id, 1); await embed.forget(memory.personaId, memory.id); release.resolve()
  assert.equal((await pending).length, 0)
  for (const id of await store.artifactIds('semantic')) assert.doesNotMatch(await readFile(join(root, 'semantic', id + '.json'), 'utf8'), new RegExp(memory.id))
})
