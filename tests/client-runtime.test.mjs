import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Window } from 'happy-dom'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { Context, Service } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as hostPlugin from '../lib/index.js'
const require = createRequire(import.meta.url)
const gatewayDir = dirname(require.resolve('@deepseek-ai/dsh-api-gateway/package.json'))
const gatewayClient = await import(pathToFileURL(join(gatewayDir, 'lib/types/client/index.js')).href)

test('built client registers through real Cordis, loads and switches personas over the real Remote namespace, and reloads cleanly', async t => {
  const base = join(process.cwd(), '.test-output'); await mkdir(base, { recursive: true }); const memoryDir = await mkdtemp(join(base, 'client-di-'))
  const window = new Window({ url: 'http://localhost' }); const previous = new Map()
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const host = new Context(), browser = new Context()
  const container = window.document.createElement('div'); window.document.body.append(container); const root = createRoot(container)
  t.after(async () => {
    await act(async () => root.unmount()); await browser.fiber.dispose(); await host.fiber.dispose(); await window.happyDOM.close()
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key] }
    assert.ok(memoryDir.startsWith(base)); await rm(memoryDir, { recursive: true, force: true })
  })
  await host.plugin(TypertRegistry); await host.plugin(RemoteAccess); await host.plugin(TypertGateway)
  await mountAgentLoopTestDependencies(host)
  await host.plugin(hostPlugin, { memoryDir, learningMode: 'off' })
  const harness = await mountAgentLoopTestHarness(host)
  const peer = { id: 'browser-test-peer', ctx: host, principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'none', async dispose() {} }
  const calls = [], opened = [], panels = [], views = [], rows = [], pending = new Set()
  async function settleRemote() {
    for (let i = 0; i < 20 && pending.size; i++) await act(async () => { await Promise.allSettled([...pending]) })
  }
  const core = new SlotCore()
  core.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' }, 'conversation.view': { kind: 'list', scope: 'session' } } }, () => null)
  function providers(ctx) {
    ctx.provide('connection', {
      interactions: 'none', isLoopback: true, generation: { getSnapshot: () => undefined },
      rpc: { open: async function* () {}, call: (_base, endpoint, payload, signal) => {
        const task = (async () => {
          signal.throwIfAborted(); const [namespace, method] = endpoint.split('/'); calls.push({ namespace, method, args: payload.args })
          return { ok: true, value: await host.typertGateway.invoke({ namespace, method, args: payload.args, peer, signal }) }
        })()
        pending.add(task); task.then(() => pending.delete(task), () => pending.delete(task)); return task
      } },
    })
    // Only renderer/navigation/locale surfaces are small collaborators; Remote and its DI guards are real.
    new class extends Service {
      constructor(scope) { super(scope, 'slots') }
      inject(_name, effect) { return this.ctx.effect(effect) }
      register(row, component) {
        const dispose = core.register(row, component)
        const entry = { row, component }; rows.push(entry)
        return this.ctx.effect(() => () => { dispose(); const index = rows.indexOf(entry); if (index >= 0) rows.splice(index, 1) })
      }
    }(ctx)
    ctx.provide('locale', { register: () => () => {}, bind: () => key => key })
    ctx.provide('layout', { selectPanel: id => panels.push(id), panelInfo: { getSnapshot: () => ({ activePanelId: panels.at(-1) ?? null }) } })
    ctx.provide('uiWorkspace', { openSession: id => opened.push(id) })
  }
  await browser.plugin(providers); await browser.plugin(TypertRegistry); await browser.plugin(gatewayClient)
  let loaded
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { loaded = value } } }, FormData: window.FormData, console, TextEncoder, TextDecoder, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  const clientPlugin = loaded.factory(require)
  const fiber = browser.plugin(clientPlugin); await fiber
  assert.equal(rows.length, 3)
  const manager = rows.find(r => r.row.name === 'main')
  assert.equal(manager.row.key, 'persona-memory')
  assert.equal(core.entries('sidebar.panellist')[0].options.id, 'persona-memory')
  const ui = manager.row.inject().ui
  assert.equal(host.agents.list().length, 0)
  const globalSnapshot = await ui.manage({ projectId: null }, { op: 'snapshot' })
  assert.equal(globalSnapshot.personas.length, 3)
  await act(async () => root.render(React.createElement(manager.component, { ui, t: key => key })))
  await settleRemote()
  assert.equal(container.querySelector('select[aria-label=managePersona]').options.length, 3)
  const historyButton = [...container.querySelectorAll('button')].find(b => b.textContent === 'historyImport')
  await act(async () => historyButton.click()); await settleRemote()
  assert.ok(container.querySelector('input[type=file]'), 'global history page opens with no conversation')
  const imported = await ui.import({ provider: '', model: '', projectId: null }, { op: 'preview', filename: 'test.md', text: '## 用户\n研究旧问题\n## 助手\n已讨论实验', format: 'markdown' }, new AbortController().signal)
  const whole = await ui.import({ provider: '', model: '', projectId: null }, { op: 'beginUpload', filename: 'whole.md', requestId: 'real-rpc-upload', parts: 1, branches: 1 }, new AbortController().signal)
  await ui.import({ provider: '', model: '', projectId: null }, { op: 'uploadPart', uploadId: whole.batchId, index: 0, text: '## 用户\n另一个旧问题\n## 助手\n完成', format: 'markdown' }, new AbortController().signal)
  const complete = await ui.import({ provider: '', model: '', projectId: null }, { op: 'finishUpload', uploadId: whole.batchId }, new AbortController().signal)
  assert.equal(complete.conversations.length, 1)
  assert.equal(host.agents.list().length, 0, 'whole-file import never creates helper sessions or sends requests')
  const continued = await ui.import({ provider: 'fake', model: 'fake', projectId: null }, { op: 'continue', batchId: imported.batchId, conversationId: imported.conversations[0].id, personaId: 'daily-companion', mode: 'full', requestId: 'from-global-page' }, new AbortController().signal)
  assert.equal(host.agents.list().length, 1, 'only the intended continuation is created, with no helper chat')
  assert.equal(host.agents.get(SessionId(continued.continuedSessionId)).options.model, 'fake')
  const agent = await harness.create(SessionId('browser-real-session'))
  const dock = rows.find(r => r.row.name === 'conversation.view')
  const injected = { ...dock.row.inject(agent.id), openView: (view, focus) => views.push({ view, focus }) }
  // This call reproduced the reported "cannot get property remote.personaMemory without inject".
  const snapshot = await injected.api({ op: 'snapshot' }); assert.equal(snapshot.personas.length, 3)
  await act(async () => root.render(React.createElement(dock.component, { ...injected, sessionId: agent.id, t: key => key })))
  await settleRemote()
  assert.equal(container.querySelectorAll('[data-persona-id]').length, 3)
  assert.equal(container.querySelector('[role=alert]'), null)
  for (const persona of snapshot.personas) assert.ok(container.textContent.includes(persona.description))
  await act(async () => container.querySelector('[data-persona-id=coding-partner]').click())
  await settleRemote()
  assert.equal(container.querySelector('[data-persona-id=coding-partner]').getAttribute('aria-pressed'), 'true')
  assert.equal(rows.some(r => r.row.name === 'conversation.input.dock'), false)
  assert.equal(dock.row.label(), 'persona')
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'backToChat').click())
  assert.deepEqual(views, [{ view: 'chat', focus: '' }])
  assert.equal((await host.personaMemory.dispatch(agent, { op: 'snapshot' })).selectedPersonaId, 'coding-partner')
  assert.equal(container.querySelector('[data-persona-import]'), null)
  assert.equal(container.querySelector('input[type=file]'), null)
  assert.equal(container.querySelector('select[aria-label=learning]'), null)
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'manage').click())
  assert.deepEqual(panels, ['persona-memory'])
  assert.equal(ui.target.getSnapshot().personaId, 'coding-partner')
  await ui.manage({ personaId: 'daily-companion', projectId: null }, { op: 'snapshot' })
  assert.equal((await host.personaMemory.dispatch(agent, { op: 'snapshot' })).selectedPersonaId, 'coding-partner', 'management browsing never switches a chat')
  assert.equal((await ui.list()).length, 2)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(ui.import({ provider: '', model: '', projectId: null }, { op: 'preview', filename: 'abort.md', text: '', format: 'markdown' }, abort.signal))
  ui.openSession('continued-session'); assert.deepEqual(opened, ['continued-session'])
  assert.ok(calls.some(c => c.method === 'dispatch')); assert.ok(calls.some(c => c.method === 'manage')); assert.ok(calls.some(c => c.method === 'managementOptions')); assert.ok(calls.some(c => c.method === 'importManaged')); assert.ok(calls.some(c => c.method === 'listImports'))
  await act(async () => root.render(null)); await fiber.dispose()
  assert.equal(panels.at(-1), null, 'unloading the selected management page returns to conversation')
  assert.equal(rows.length, 0); assert.equal(browser.get('remote.personaMemory'), undefined)
  const reloaded = browser.plugin(clientPlugin); await reloaded
  assert.equal(rows.length, 3)
  assert.equal((await rows.find(r => r.row.name === 'conversation.view').row.inject(agent.id).api({ op: 'snapshot' })).selectedPersonaId, 'coding-partner')
  await reloaded.dispose(); assert.equal(rows.length, 0)
})
