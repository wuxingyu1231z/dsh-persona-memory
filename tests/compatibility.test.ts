import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyHost } from '../src/index.ts'
import { apply as applyClient } from '../src/client/index.tsx'

test('an incompatible host fails before opening or creating memory files', async t => {
  const base = join(process.cwd(), '.test-output'); await mkdir(base, { recursive: true })
  const folder = await mkdtemp(join(base, 'compatibility-probe-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const memoryDir = join(folder, 'memory')
  const ctx = { agents: { create: null, get() {}, list() { return [] } }, systemPrompt: { section() {} }, llm: { stream() {}, listProviders() {}, listModels() {} } } as unknown as Context
  await assert.rejects(applyHost(ctx, { memoryDir }), /DSH.*Host.*agents\.create/)
  await assert.rejects(access(memoryDir), /ENOENT/)
})

test('an incompatible client fails before mounting its remote or registering panels', async () => {
  let mounted = false, registered = false
  const ctx = {
    remote: { $mount() { mounted = true } }, slots: { inject() {}, register() { registered = true } },
    locale: { register() {}, bind() {} }, uiWorkspace: { openSession: undefined },
    layout: { selectPanel() {}, panelInfo: { getSnapshot() {} } },
  } as unknown as Context
  await assert.rejects(applyClient(ctx), /DSH.*Client.*uiWorkspace\.openSession/)
  assert.equal(mounted, false); assert.equal(registered, false)
})
