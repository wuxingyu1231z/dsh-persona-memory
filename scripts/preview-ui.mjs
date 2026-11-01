// Disposable browser fixture for inspecting the plugin in system light/dark colors.
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { build } from 'tsdown'
const folder = resolve('.test-output/ui-preview'); await mkdir(folder, { recursive: true })
await writeFile(join(folder, 'entry.tsx'), `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ManagementPage } from '../../src/client/ManagementPage.tsx'
import { PersonaPanel } from '../../src/client/PersonaPanel.tsx'
import { zh } from '../../src/client/locales.ts'
const params = new URLSearchParams(location.search), theme = params.get('theme') ?? 'dark'
document.documentElement.style.colorScheme = theme
document.body.style.background = theme === 'dark' ? '#151515' : '#ffffff'
document.body.style.color = theme === 'dark' ? '#ededed' : '#202020'
const now = new Date().toISOString()
let view = { personaId: 'research-mentor', projectId: null }; const listeners = new Set()
const personas = [
 { id: 'research-mentor', name: '科研导师', description: '严谨、善于追问，关注研究问题、实验与论文写作。', prompt: '帮助规划实验和论文。', revision: 1, updatedAt: now },
 { id: 'coding-partner', name: '编程搭档', description: '遵循编码习惯，使用实际检查验证结果。', prompt: '验证代码。', revision: 1, updatedAt: now },
 { id: 'daily-companion', name: '日常陪伴', description: '自然温柔地聊天，记住生活偏好。', prompt: '自然交流。', revision: 1, updatedAt: now },
]
let state = { phase: 3, personas, selectedPersonaId: 'research-mentor', activePersonaId: null, projectId: null, storagePath: 'DSH_HOME / memory', learningMode: 'auto', memories: ['user_name', 'writing_style'].map((key, i) => ({ id: 'preview-memory-' + i, personaId: 'research-mentor', projectId: null, key, content: i ? '科研讨论先给结论，再解释依据。' : '用户自称小帅，这是其名字或昵称。', category: 'preference', pinned: true, locked: false, expiresAt: null, status: 'active', revision: 1, source: { kind: 'learned' }, createdAt: now, updatedAt: now })), candidates: [], learningJobs: [], verification: { status: 'not-run', checks: [], at: null } }
const ui = {
 target: { getSnapshot: () => view, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) } },
 setTarget: next => { view = next; for (const fn of listeners) fn() },
 manage: async (view, request) => { if (request.op === 'select') state = { ...state, selectedPersonaId: request.personaId }; return { ...state, selectedPersonaId: request.personaId ?? view.personaId ?? state.selectedPersonaId } },
 options: async () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }], models: [{ provider: 'deepseek', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }], projects: [], workspaces: [{ id: 'workspace-default', name: 'default-workspace', path: 'D:/Harness/默认工作区' }, { id: 'workspace-research', name: '科研工作区', path: 'D:/learn/科研项目' }], defaultWorkspaceId: 'workspace-default', defaultProvider: 'deepseek', defaultModel: 'deepseek-v4.1-flash' }),
 list: async () => params.has('continuation') ? [{ id: 'fixture-history', filename: '示例历史.json', createdAt: now, conversations: 1 }] : [],
 import: async () => ({ batchId: 'fixture-history', filename: '示例历史.json', warnings: [], conversations: [{ id: 'fixture-conversation', sourceId: 'fixture-source', branchId: 'main', platform: 'deepseek', title: '实验讨论', preferred: true, warnings: [], analysisReady: true, analysis: { summary: '已讨论对照实验，下一步整理结果。', personaDraft: { name: '导师', description: '严谨', prompt: '提供科研指导' }, topic: 'research', proposals: [] }, messageCount: 2, estimatedCalls: 1 }], page: { conversationId: 'fixture-conversation', offset: 0, total: 2, messages: [] }, continuedSessionId: null, stagedCandidates: 0, savedMemories: 0 }), openSession() {}, back() {},
}
const t = key => zh[key]
createRoot(document.getElementById('root')).render(params.has('personas') ? <><nav style={{display:'flex',gap:28,padding:20,borderBottom:'1px solid #8886'}}><span>对话</span><span>轨迹</span><strong>人格</strong></nav><PersonaPanel api={async request => { if (request.op === 'select') state = { ...state, selectedPersonaId: request.personaId }; return state }} sessionId="preview" openManagement={() => {}} openView={() => {}} t={t} /></> : <ManagementPage ui={ui} t={t} />)
setTimeout(() => {
 if (params.get('tab') === 'history') [...document.querySelectorAll('nav button')].find(b => b.textContent === zh.historyImport)?.click()
 setTimeout(() => {
  if (params.has('create')) [...document.querySelectorAll('button')].find(b => b.textContent === zh.create)?.click()
  if (params.has('continuation')) { const archive = document.querySelector('select[aria-label="' + zh.archives + '"]'); archive.value = 'fixture-history'; archive.dispatchEvent(new Event('change', {bubbles:true})) }
  setTimeout(() => {
  const workspacePicker = document.querySelector('select[aria-label="' + zh.continuationWorkspace + '"]')
  if (params.has('continuation')) workspacePicker?.scrollIntoView({block:'center'})
  const colors = [...document.querySelectorAll('select option')].map(option => { const s = getComputedStyle(option); return { text: option.textContent, color: s.color, background: s.backgroundColor } })
  const report = document.createElement('script'); report.id = 'visual-report'; report.type = 'application/json'
  report.textContent = JSON.stringify({ theme, viewport: innerWidth, colors, overflow: [...document.querySelectorAll('main,section')].some(e => e.scrollWidth > e.clientWidth + 1) || document.documentElement.scrollWidth > innerWidth, hasImport: !!document.querySelector('input[type=file]'), hasCreatePersona: !!document.querySelector('[data-create-import-persona]'), hasWorkspacePicker: !!workspacePicker, selectedWorkspace: workspacePicker?.value, personaCount: document.querySelectorAll('[data-persona-id]').length, hasExpiryInput: !!document.querySelector('input[type=datetime-local]'), hasReview: [...document.querySelectorAll('h4')].some(e => e.textContent.includes('待确认')) })
  document.body.append(report)
  if (window !== window.top) window.top.postMessage(JSON.parse(report.textContent), '*')
  }, 100)
 }, 100)
}, 100)
`)
await build({ entry: { preview: join(folder, 'entry.tsx') }, outDir: folder, platform: 'browser', format: 'iife', target: 'es2022', clean: false, dts: false, deps: { onlyBundle: false } })
await writeFile(join(folder, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>人格与记忆预览</title><style>html,body,#root{margin:0;height:100%;font:15px "Microsoft YaHei",sans-serif}button,input,select,textarea{font:inherit}</style><div id="root"></div><script src="preview.iife.js"></script></html>')
console.log(folder)
