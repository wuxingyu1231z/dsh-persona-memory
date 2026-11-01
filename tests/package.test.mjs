import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Window } from 'happy-dom'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
const require = createRequire(import.meta.url)

test('release entry points exist and the built Host persists memory without TypeScript tooling', async t => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const path of [pkg.main, pkg.types, pkg.exports['./client'], pkg.dsh.bundle.patch]) await stat(new URL('../' + path, import.meta.url))
  const host = await import('../lib/index.js')
  assert.equal(typeof host.apply, 'function')
  assert.equal(typeof host.PersonaMemoryService, 'function')
  const { MemoryStore } = await import('../lib/store.js')
  const base = join(process.cwd(), '.test-output'); await mkdir(base, { recursive: true })
  const path = await mkdtemp(join(base, 'built-store-'))
  t.after(() => { assert.ok(path.startsWith(base)); return rm(path, { recursive: true, force: true }) })
  const store = new MemoryStore(path); await store.initialize()
  await store.remember({ personaId: 'research-mentor', projectId: null, key: 'release', content: 'built memory', category: 'fact', pinned: true }, 0, { kind: 'user' })
  assert.equal((await new MemoryStore(path).memories('research-mentor'))[0].content, 'built memory')
  await stat(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url))
})
test('built browser factory renders and performs persona and project-memory actions', async t => {
  const window = new Window({ url: 'http://localhost' })
  const previous = new Map()
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  let loaded
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: value => { loaded = value } } }, FormData: window.FormData, console, TextEncoder, TextDecoder, URL, setTimeout, clearTimeout, setInterval, clearInterval })
  assert.equal(loaded.id, 'dsh-persona-memory')
  const client = loaded.factory(require)
  assert.equal(typeof client.apply, 'function')
  const now = new Date().toISOString()
  let state = { phase: 3, storagePath: '/private/memory', selectedPersonaId: 'research-mentor', activePersonaId: null, projectId: 'project-a', learningMode: 'auto', candidates: [], learningJobs: [], verification: { status: 'not-run', checks: [], at: null },
    personas: [{ id: 'research-mentor', name: '科研导师', description: '严谨', prompt: '科研', revision: 1, updatedAt: now }, { id: 'coding-partner', name: '编程搭档', description: '验证', prompt: '编程', revision: 1, updatedAt: now }],
    memories: [{ id: 'memory-a', personaId: 'research-mentor', projectId: 'project-a', key: '项目习惯', content: '需要测试', category: 'preference', pinned: true, locked: false, expiresAt: null, revision: 1, status: 'active', source: { kind: 'user' }, createdAt: now, updatedAt: now }],
  }
  const requests = []
  const api = async request => {
    requests.push(request)
    if (request.op === 'select') state = { ...state, selectedPersonaId: request.personaId }
    if (request.op === 'savePersona') state = { ...state, personas: [...state.personas, { ...request.persona, revision: 1, updatedAt: now }] }
    if (request.op === 'learningMode') state = { ...state, learningMode: request.mode }
    if (request.op === 'lockMemory') state = { ...state, memories: state.memories.map(m => m.id === request.memoryId ? { ...m, locked: request.locked, expiresAt: request.expiresAt, revision: m.revision + 1 } : m) }
    if (request.op === 'candidate') state = { ...state, candidates: state.candidates.filter(c => c.id !== request.candidateId) }
    return state
  }
  const labels = { title: '人格与记忆', manage: '管理', close: '收起', refresh: '刷新', create: '新建人格', editMemory: '纠正', save: '保存', remember: '保存记忆' }
  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = createRoot(container)
  t.after(async () => {
    await act(async () => root.unmount())
    await window.happyDOM.close()
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key] }
  })
  await act(async () => root.render(React.createElement(client.PersonaEditor, { api, sessionId: 'test', t: key => labels[key] ?? key })))
  const click = async text => { const item = [...container.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(item, text); await act(async () => item.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))) }
  assert.match(container.textContent, /项目习惯/)
  const learningMode = container.querySelector('select[aria-label="learning"]')
  learningMode.value = 'explicit'
  await act(async () => learningMode.dispatchEvent(new window.Event('change', { bubbles: true })))
  assert.equal(requests.at(-1).op, 'learningMode')
  assert.equal(requests.at(-1).mode, 'explicit')
  await click('lock')
  assert.equal(requests.at(-1).op, 'lockMemory')
  assert.equal(requests.at(-1).locked, true)
  await click('纠正')
  const memoryForm = container.querySelector('form')
  memoryForm.querySelector('[name=content]').value = '修正后的项目习惯'
  await act(async () => memoryForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(requests.at(-1).op, 'remember')
  assert.equal(requests.at(-1).memory.projectId, 'project-a')
  state = { ...state, candidates: [{ id: 'candidate-a', revision: 1, personaId: 'research-mentor', projectId: null, status: 'pending', reason: 'inferred', sources: [{ text: '用户的原始依据' }], targetId: null, proposal: { key: '表达习惯', content: '先给结论' } }] }
  await click('刷新')
  assert.doesNotMatch(container.textContent, /先给结论/)
  assert.equal(container.querySelector('input[type=datetime-local]'), null)
  assert.equal([...container.querySelectorAll('button')].some(b => b.textContent === 'accept' || b.textContent === 'reject'), false)
  await click('新建人格')
  const form = container.querySelector('form')
  for (const [key, value] of Object.entries({ id: 'new-persona', name: '新人格', description: '我的人格', prompt: '温柔自然' })) form.querySelector(`[name=${key}]`).value = value
  await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(requests.at(-1).op, 'savePersona')
  assert.match(container.textContent, /新人格/)
  const select = container.querySelector('select')
  select.value = 'coding-partner'
  await act(async () => select.dispatchEvent(new window.Event('change', { bubbles: true })))
  assert.equal(requests.at(-1).personaId, 'coding-partner')
})

test('built import UI previews a file, applies an editable persona draft and opens a continuation with idempotent retries', async t => {
  const window = new Window({ url: 'http://localhost' }); const previous = new Map()
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  let loaded
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: value => { loaded = value } } }, FormData: window.FormData, console, TextEncoder, TextDecoder, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval })
  const client = loaded.factory(require); const actions = []; const navigated = []; const now = new Date().toISOString()
  let state = { phase: 3, storagePath: '/test/memory', selectedPersonaId: 'research-mentor', activePersonaId: null, projectId: null, learningMode: 'off', memories: [], candidates: [], learningJobs: [], verification: { status: 'not-run', checks: [], at: null }, personas: [{ id: 'research-mentor', name: '导师', description: '', prompt: '严谨', revision: 1, updatedAt: now }] }
  const conv = { id: 'conv-one', sourceId: 'web-chat', branchId: 'leaf', platform: 'chatgpt', title: '旧实验', preferred: true, warnings: [], analysis: null, messageCount: 2, estimatedCalls: 1 }
  let response = { batchId: 'batch-one', filename: 'history.json', warnings: ['附件未导入'], conversations: [conv], page: { conversationId: conv.id, offset: 0, total: 2, messages: [{ id: 'u', role: 'user', text: '<script>literal source</script>', at: null }, { id: 'a', role: 'assistant', text: '实验建议', at: null }] }, continuedSessionId: null, stagedCandidates: 0, savedMemories: 0 }
  let retry = false
  const imports = {
    list: async () => actions.length ? [{ id: 'batch-one', filename: 'history.json', createdAt: now, conversations: 1 }] : [],
    request: async (request, signal) => {
      assert.equal(signal.aborted, false); actions.push(request)
      if (request.op === 'beginUpload' || request.op === 'uploadPart') return { ...response, batchId: 'upload-test', conversations: [], page: null }
      if (request.op === 'analyze') response = { ...response, conversations: [{ ...conv, analysis: { summary: '已完成实验 A，下一步做对照。', personaDraft: { name: '导入导师', description: '严谨', prompt: '指导研究' }, topic: 'research', proposals: [] } }] }
      if (request.op === 'apply') { assert.ok(request.newPersona); state = { ...state, personas: [...state.personas, { ...request.newPersona, revision: 1, updatedAt: now }] }; response = { ...response, savedMemories: 1 } }
      if (request.op === 'continue') { if (!retry) { retry = true; throw new Error('connection interrupted') }; return { ...response, continuedSessionId: 'session-import-created' } }
      return response
    }, openSession: id => navigated.push(id),
  }
  const api = async request => {
    if (request.op === 'savePersona') state = { ...state, personas: [...state.personas, { ...request.persona, revision: 1, updatedAt: now }] }
    if (request.op === 'select') state = { ...state, selectedPersonaId: request.personaId }
    return state
  }
  const container = window.document.createElement('div'); window.document.body.append(container); const root = createRoot(container)
  t.after(async () => { await act(async () => root.unmount()); await window.happyDOM.close(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key] } })
  let view = { projectId: null }; const listeners = new Set()
  const ui = {
    target: { getSnapshot: () => view, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) } },
    setTarget: next => { view = next; for (const fn of listeners) fn() },
    manage: async (_view, request) => api(request),
    options: async () => ({ providers: [{ id: 'fake', name: 'Fake' }], models: [], projects: [], workspaces: [{ id: 'workspace-default', name: 'default-workspace', path: 'D:/default' }, { id: 'workspace-research', name: '科研空间', path: 'D:/research' }], defaultWorkspaceId: 'workspace-default', defaultProvider: 'fake', defaultModel: 'fake-model' }),
    import: async (selection, request, signal) => { assert.equal(selection.provider, 'fake'); assert.equal(selection.model, 'fake-model'); return imports.request(request, signal) },
    list: imports.list, openSession: imports.openSession, back() {},
  }
  await act(async () => root.render(React.createElement(client.ManagementPage, { ui, t: key => key })))
  const click = async text => { const item = [...container.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(item, text); await act(async () => item.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))) }
  await click('historyImport')
  await click('create')
  const createForm = container.querySelector('[data-create-import-persona]')
  assert.ok(createForm, 'persona creation is available before any file or analysis')
  for (const [key, value] of Object.entries({ id: 'before-import', name: '导入前创建的人格', description: '专用目标', prompt: '认真指导' })) createForm.querySelector(`[name=${key}]`).value = value
  await act(async () => createForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(container.querySelector('select[aria-label=managePersona]').value, 'before-import')
  assert.equal(actions.length, 0, 'creating an import target does not analyze or send history')
  const file = container.querySelector('input[type=file]')
  const wholeExport = JSON.stringify(Array.from({ length: 307 }, (_, index) => ({ id: `history-${index}`, messages: [{ role: 'user', content: `question ${index}` }, { role: 'tool', content: 'discard this tool payload' }, { role: 'assistant', content: 'visible reply' }] })))
  Object.defineProperty(file, 'files', { configurable: true, value: [{ name: 'history.json', size: Buffer.byteLength(wholeExport), text: async () => wholeExport }] })
  await act(async () => { file.dispatchEvent(new window.Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.deepEqual(actions.map(a => a.op), ['beginUpload', ...Array(10).fill('uploadPart'), 'finishUpload'])
  const uploaded = actions.filter(a => a.op === 'uploadPart').flatMap(a => { const value = JSON.parse(a.text); return Array.isArray(value) ? value : [value] })
  assert.deepEqual(uploaded.map(c => c.id), Array.from({ length: 307 }, (_, index) => `history-${index}`))
  assert.doesNotMatch(JSON.stringify(uploaded), /discard this tool payload/)
  assert.match(container.textContent, /importedAll: 307/); assert.match(container.textContent, /literal source/); assert.equal(container.querySelector('script'), null)
  await click('extractCurrent'); assert.match(container.textContent, /下一步做对照/)
  const target = container.querySelector('select[aria-label=importTarget]'); target.value = '__new'
  await act(async () => target.dispatchEvent(new window.Event('change', { bubbles: true })))
  assert.equal(container.querySelector('textarea[aria-label=draftPrompt]').value, '指导研究')
  await click('applyCurrent'); assert.equal(actions.at(-1).op, 'apply'); assert.match(container.textContent, /导入导师/); assert.match(container.textContent, /savedMemories: 1/)
  const workspace = container.querySelector('select[aria-label=continuationWorkspace]')
  assert.equal(workspace.value, 'workspace-default')
  assert.match(workspace.textContent, /科研空间.*D:\/research/)
  workspace.value = 'workspace-research'
  await act(async () => workspace.dispatchEvent(new window.Event('change', { bubbles: true })))
  assert.equal(container.querySelector('select[aria-label=managementScope]').value, '', 'workspace selection does not change the memory scope')
  await click('continueHistory'); assert.match(container.textContent, /connection interrupted/); assert.equal(navigated.length, 0)
  assert.equal(actions.at(-1).workspaceId, 'workspace-research')
  const firstRequestId = actions.at(-1).requestId
  await click('continueHistory'); assert.equal(actions.at(-1).requestId, firstRequestId); assert.deepEqual(navigated, ['session-import-created'])
  assert.equal(actions.at(-1).personaId, state.selectedPersonaId)
  workspace.value = ''
  await act(async () => workspace.dispatchEvent(new window.Event('change', { bubbles: true })))
  assert.equal([...container.querySelectorAll('button')].some(b => b.textContent === 'refreshWorkspaces'), false)
  await click('continueHistory')
  assert.equal(actions.at(-1).workspaceId, null); assert.notEqual(actions.at(-1).requestId, firstRequestId)
  // The built browser must auto-partition a single many-branch file as well as many conversations.
  const previousActions = actions.length
  const mapping = { root: { parent: null, message: { id: 'shared', role: 'user', content: '共同前文' } } }
  for (let i = 0; i < 73; i++) mapping[`answer-${i}`] = { parent: 'root', message: { id: `a-${i}`, role: 'assistant', content: `分支正文 ${i}` } }
  const manyBranches = JSON.stringify({ id: 'browser-branches', current_node: 'answer-39', mapping })
  Object.defineProperty(file, 'files', { configurable: true, value: [{ name: 'many.json', size: Buffer.byteLength(manyBranches), text: async () => manyBranches }] })
  await act(async () => { file.dispatchEvent(new window.Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 20)) })
  const uploadedParts = actions.slice(previousActions)
  assert.equal(uploadedParts[0].op, 'beginUpload'); assert.equal(uploadedParts[0].branches, 73)
  assert.equal(uploadedParts.at(-1).op, 'finishUpload')
  const { parseHistory } = await import('../lib/import-parser.js')
  const branches = uploadedParts.filter(a => a.op === 'uploadPart').flatMap(a => parseHistory('many.json', a.text, a.format).conversations)
  assert.equal(branches.length, 73); assert.equal(new Set(branches.map(c => c.id)).size, 73)
  assert.equal(branches.find(c => c.preferred).branchId, 'answer-39')
  assert.ok(branches.every(c => c.messages[0].text === '共同前文'))
  assert.equal(container.querySelector('[role=alert]'), null)
})

test('distributed preprocessing CLI writes one cleaned whole export and report without overwriting originals or output', async t => {
  const base = join(process.cwd(), '.test-output'); await mkdir(base, { recursive: true }); const folder = await mkdtemp(join(base, 'preprocess-cli-'))
  t.after(() => { assert.ok(folder.startsWith(base)); return rm(folder, { recursive: true, force: true }) })
  const input = join(folder, 'conversations.json'), output = join(folder, 'cleaned')
  const raw = JSON.stringify([{ id: 'cli-1', messages: [{ role: 'user', content: 'question' }, { role: 'tool', content: 'large tool payload' }, { role: 'assistant', content: 'answer' }] }, { id: 'cli-2', messages: [{ role: 'user', content: 'another question' }] }])
  await writeFile(input, raw)
  const run = () => execFileSync(process.execPath, ['bin/preprocess.mjs', input, output], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  run()
  assert.equal(await readFile(input, 'utf8'), raw)
  const cleaned = await readFile(join(output, 'conversations.cleaned.json'), 'utf8'), report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  assert.deepEqual(JSON.parse(cleaned).map(c => c.id), ['cli-1', 'cli-2']); assert.doesNotMatch(cleaned, /large tool payload/)
  assert.equal(report.sourceConversations, 2); assert.equal(report.branchRecords, 2); assert.equal(report.skipped.length, 0)
  assert.throws(run, /EEXIST/)
})
