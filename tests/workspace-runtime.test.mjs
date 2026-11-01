import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, rmdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import * as plugin from '../lib/index.js'
import { readRuntimeConfig } from '../scripts/runtime-config.mjs'
// These installation-only collaborators are loaded from the actual DSH runtime, not mocked.
const { runtime } = readRuntimeConfig()
const installed = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
const [{ default: Storage }, StorageJson, StorageDomain] = await Promise.all(['dsh-storage', 'dsh-storage-json', 'dsh-storage-domain'].map(installed))

test('real workspace registry receives selected continuations independently of memory scope; ungrouped stays ungrouped after restart', async t => {
  const base = join(process.cwd(), '.test-output'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'workspace-continuation-'))
  const contexts = [], defaultDir = join(root, 'default-workspace'), otherDir = join(root, 'research')
  t.after(async () => { for (const ctx of contexts.reverse()) await ctx.fiber.dispose(); assert.ok(root.startsWith(base)); await rm(root, { recursive: true, force: true }) })
  async function boot() {
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(TypertRegistry); await ctx.plugin(RemoteAccess); await ctx.plugin(TypertGateway)
    await mountAgentLoopTestDependencies(ctx); provideWorkingDirectoryFixture(ctx, defaultDir)
    await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(Storage); await ctx.plugin(StorageJson, { root: join(root, 'storage') }); await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(WorkspaceRegistry)
    await ctx.plugin(plugin, { memoryDir: join(root, 'memory'), learningMode: 'off' })
    await mountAgentLoopTestHarness(ctx)
    return ctx
  }
  const ctx = await boot(), registry = ctx.workspaceRegistry
  const primary = await registry.initializeDefault(async () => defaultDir)
  assert.ok(primary); await primary.setTitle('已改名的默认工作区')
  await mkdir(otherDir); const research = await registry.create(otherDir, '科研空间')
  const peer = { id: 'workspace-owner', ctx, principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'none', async dispose() {} }
  const rpc = (method, args) => ctx.typertGateway.invoke({ peer, namespace: 'personaMemory', method, args, signal: new AbortController().signal })
  const options = await rpc('managementOptions', {})
  assert.equal(options.defaultWorkspaceId, primary.id, 'the durable default identity survives rename and reordering')
  assert.ok(options.workspaces.some(w => w.id === research.id && w.name === '科研空间' && w.path === research.path))
  const selection = { provider: 'unused', model: 'unused', projectId: 'memory-project-only' }
  const archive = await rpc('importManaged', { selection, request: { op: 'preview', filename: 'workspace.md', format: 'markdown', text: '## 用户\n旧问题\n## 助手\n旧答案' } })
  const memory = await ctx.personaMemory.store.remember({ personaId: 'research-mentor', projectId: selection.projectId, key: 'scope', content: '只属于原记忆项目', category: 'fact', pinned: false }, 0, { kind: 'user' })
  const request = { op: 'continue', batchId: archive.batchId, conversationId: archive.conversations[0].id, personaId: 'research-mentor', mode: 'full', requestId: 'same-request' }
  const create = workspaceId => rpc('importManaged', { selection, request: { ...request, workspaceId } })
  const inResearch = await create(research.id), researchId = SessionId(inResearch.continuedSessionId)
  assert.equal(ctx.agents.get(researchId).session.header.cwd, research.path)
  assert.ok(research.sessionIds.includes(researchId)); assert.ok(!primary.sessionIds.includes(researchId))
  assert.equal((await create(research.id)).continuedSessionId, researchId, 'retry does not duplicate or move another chat')
  const inDefault = await create(primary.id), defaultId = SessionId(inDefault.continuedSessionId)
  assert.notEqual(defaultId, researchId); assert.ok(primary.sessionIds.includes(defaultId))
  const ungrouped = await create(null), ungroupedId = SessionId(ungrouped.continuedSessionId)
  assert.equal(ctx.agents.get(ungroupedId).session.header.cwd, defaultDir)
  assert.ok(!registry.list().some(w => w.sessionIds.includes(ungroupedId)), 'a matching cwd does not auto-group an explicitly ungrouped chat')
  assert.deepEqual(await ctx.personaMemory.store.memories('research-mentor'), [memory], 'continuation placement never changes memory ownership')
  const count = ctx.agents.list().length
  await assert.rejects(create('deleted-workspace'), /已不存在/)
  const missingDir = join(root, 'missing'); await mkdir(missingDir); const missing = await registry.create(missingDir, '临时目录')
  await rmdir(missingDir) // empty explicitly named test directory only
  await assert.rejects(create(missing.id), /目录不可用/)
  assert.equal(ctx.agents.list().length, count, 'invalid workspaces are rejected before creating a session')
  await ctx.fiber.dispose()
  const resumed = await boot()
  assert.ok(resumed.workspaceRegistry.get(research.id).sessionIds.includes(researchId))
  assert.ok(resumed.workspaceRegistry.get(primary.id).sessionIds.includes(defaultId))
  assert.ok(!resumed.workspaceRegistry.list().some(w => w.sessionIds.includes(ungroupedId)))
  assert.equal((await resumed.personaMemory.managementOptions()).defaultWorkspaceId, primary.id)
})
