import { createHash } from 'node:crypto'
import { batchSchema, type ImportBatch, type ImportedConversation, type HistoryMessage } from './import-schema.ts'

export const digest = (text: string) => createHash('sha256').update(text).digest('hex')
type Obj = Record<string, unknown>
function obj(value: unknown): Obj { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('导出结构需要对象'); return value as Obj }
function optionalObj(value: unknown): Obj | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : undefined }
function time(value: unknown): number | null {
  const n = typeof value === 'number' ? value * (value < 1e11 ? 1000 : 1) : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}
function body(message: Obj, warnings: Set<string>): { role: 'user' | 'assistant'; text: string } | undefined {
  if (Array.isArray(message.fragments)) {
    const fragments = message.fragments.map(obj)
    const types = new Set(fragments.map(f => f.type).filter(t => t === 'REQUEST' || t === 'RESPONSE'))
    if (types.size > 1) throw new Error('DeepSeek 节点混合了用户与助手正文，请检查导出')
    if (fragments.some(f => !['REQUEST', 'RESPONSE'].includes(String(f.type)))) warnings.add('思考过程、工具活动及附件仅保留提示，不作为可执行上下文导入。')
    const text = fragments.filter(f => f.type === 'REQUEST' || f.type === 'RESPONSE').map(f => { if (typeof f.content !== 'string') throw new Error('DeepSeek 正文不是字符串'); return f.content }).join('\n\n')
    if (!types.size) return
    return { role: types.has('RESPONSE') ? 'assistant' : 'user', text }
  }
  const author = optionalObj(message.author)
  const role = message.role ?? author?.role
  if (role !== 'user' && role !== 'assistant') { warnings.add('已忽略系统提示、工具角色和无法识别角色的消息。'); return }
  const content = message.content
  let text = typeof content === 'string' ? content : ''
  const structured = optionalObj(content)
  if (structured) {
    if (structured.content_type && !['text', 'multimodal_text'].includes(String(structured.content_type))) { warnings.add('非正文、推理或附件内容未导入。'); return }
    if (Array.isArray(structured.parts)) {
      text = structured.parts.filter(p => typeof p === 'string').join('\n')
      if (structured.parts.some(p => typeof p !== 'string')) warnings.add('图片、音频及附件本体未包含在本次纯文本导入中。')
    } else if (typeof structured.text === 'string') text = structured.text
  }
  return { role, text }
}
function makeConversation(sourceId: string, title: string, branchId: string, platform: ImportedConversation['platform'], preferred: boolean, messages: HistoryMessage[], warnings: Set<string>): ImportedConversation {
  if (messages.some(m => m.at === null)) warnings.add('部分消息缺少可靠时间，导入时间不代表偏好的发生时间。')
  const identity = `${platform}:${sourceId}:${branchId}`
  return { id: `conv-${digest(identity).slice(0, 32)}`, sourceId, title: title.slice(0, 300), branchId, platform, preferred, messages, warnings: [...warnings], parts: [], analysis: null, analysisKey: '' }
}
function jsonConversation(raw: unknown, index: number, maxBranches: number): ImportedConversation[] {
  const c = obj(raw)
  const sourceId = String(c.id ?? c.conversation_id ?? `anonymous-${digest(JSON.stringify(c)).slice(0, 24)}`).slice(0, 300)
  const title = String(c.title ?? c.name ?? `对话 ${index + 1}`)
  const preprocessing = optionalObj(c.personaMemoryPreprocessing)
  const notes = preprocessing?.version === 1 && Array.isArray(preprocessing.warnings) ? preprocessing.warnings.filter((w): w is string => typeof w === 'string').slice(0, 16).map(w => w.slice(0, 300)) : []
  if (c.mapping) {
    const map = obj(c.mapping)
    const keys = Object.keys(map)
    if (!keys.length || keys.length > 20000) throw new Error('对话图为空或节点过多')
    const parents = new Set<string>()
    for (const key of keys) {
      const node = obj(map[key]); if (node.parent !== null && node.parent !== undefined) { const parent = String(node.parent); if (!Object.hasOwn(map, parent)) throw new Error('分支引用缺失节点'); parents.add(parent) }
    }
    const leaves = keys.filter(k => !parents.has(k))
    const current = c.current_node === undefined || c.current_node === null ? undefined : String(c.current_node)
    if (current && !Object.hasOwn(map, current)) throw new Error('current_node 未指向有效节点')
    const tips = [...new Set([...(current ? [current] : []), ...leaves])]
    if (!tips.length || tips.length > maxBranches) throw new Error('分支过多或对话图无有效末节点')
    // Visit every path, including disconnected cycles, before returning any branch.
    const valid = new Set<string>()
    for (const key of keys) {
      const path = new Set<string>(); let at: string | null = key
      while (at !== null && !valid.has(at)) { if (path.has(at)) throw new Error('对话图存在循环'); path.add(at); const parent: unknown = obj(map[at]).parent; at = parent === null || parent === undefined ? null : String(parent) }
      for (const id of path) valid.add(id)
    }
    return tips.flatMap(tip => {
      const path: string[] = []; let at: string | null = tip
      while (at !== null) { path.push(at); const parent: unknown = obj(map[at]).parent; at = parent === null || parent === undefined ? null : String(parent) }
      const warnings = new Set<string>(notes); let platform: ImportedConversation['platform'] = 'chatgpt'
      const messages = path.reverse().flatMap(id => {
        const node = obj(map[id]); const message = optionalObj(node.message); if (!message) return []
        if (Array.isArray(message.fragments)) platform = 'deepseek'
        const parsed = body(message, warnings); if (!parsed?.text.trim()) return []
        return [{ id: String(message.id ?? id).slice(0, 300), ...parsed, at: time(message.create_time ?? message.inserted_at ?? message.created_at) }]
      })
      return messages.length ? [makeConversation(sourceId, title, tip, platform, tip === (current ?? leaves[0]), messages, warnings)] : []
    })
  }
  const list = c.messages ?? c.chat_messages
  if (!Array.isArray(list)) throw new Error('未识别的 JSON 格式：需要 mapping 或 messages')
  const warnings = new Set<string>(notes)
  const messages = list.flatMap((raw, i) => {
    const m = obj(raw); const parsed = body(m, warnings); if (!parsed?.text.trim()) return []
    return [{ id: String(m.id ?? `message-${i}-${digest(parsed.text).slice(0, 16)}`).slice(0, 300), ...parsed, at: time(m.create_time ?? m.inserted_at ?? m.timestamp ?? m.created_at) }]
  })
  return messages.length ? [makeConversation(sourceId, title, 'main', 'generic', true, messages, warnings)] : []
}
function markdown(text: string, filename: string): ImportedConversation[] {
  const messages: HistoryMessage[] = []; let role: HistoryMessage['role'] | undefined; let content: string[] = []; let fence: string | undefined
  let title = filename
  const finish = () => { const body = content.join('\n').trim(); if (role && body) messages.push({ id: `md-${messages.length}-${digest(role + body).slice(0, 20)}`, role, text: body, at: null }); content = [] }
  for (const line of text.split(/\r?\n/u)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (marker) { const ch = marker[1][0]; if (!fence) fence = ch; else if (fence === ch) fence = undefined; content.push(line); continue }
    const heading = !fence ? /^(?:#{1,6}\s+|\*\*)(User|Human|Assistant|ChatGPT|DeepSeek|用户|人类|助手)(?:\*\*)?\s*[:：]?\s*$/iu.exec(line.trim()) : null
    const simple = !fence ? /^(User|Human|Assistant|ChatGPT|DeepSeek|用户|人类|助手)\s*[:：]\s*(.*)$/iu.exec(line) : null
    const match = heading ?? simple
    if (match) { finish(); role = /^(user|human|用户|人类)$/iu.test(match[1]) ? 'user' : 'assistant'; if (simple?.[2]) content.push(simple[2]); continue }
    if (!role && /^#\s+/.test(line)) title = line.replace(/^#\s+/, '').trim()
    else if (role) content.push(line)
  }
  finish()
  if (!messages.length) throw new Error('Markdown 需要明确角色标记，例如 ## 用户 / ## 助手 或 User: / Assistant:')
  return [makeConversation(`markdown-${digest(messages.map(m => m.role + m.text).join('\n')).slice(0, 24)}`, title, 'main', 'markdown', true, messages, new Set(['Markdown 未提供可靠时间，导入偏好不会因导入较晚而优先于已有记忆。']))]
}
export function parseHistory(filename: string, text: string, format: 'auto' | 'json' | 'markdown', limits = { chars: 4000000, conversations: 128, branches: 16, messages: 20000 }): ImportBatch {
  if (text.length > limits.chars) throw new Error('导入文件超过字符上限')
  text = text.replace(/^\uFEFF/u, '')
  const json = format === 'json' || (format === 'auto' && /^[\s]*[\[{]/u.test(text))
  let conversations: ImportedConversation[]
  if (json) {
    const raw: unknown = JSON.parse(text)
    const container = optionalObj(raw)
    const list = Array.isArray(raw) ? raw : Array.isArray(container?.conversations) ? container.conversations : [raw]
    if (list.length > limits.conversations) throw new Error('导出的会话数量超过上限，请拆分文件')
    conversations = list.flatMap((c, i) => jsonConversation(c, i, limits.branches))
  } else conversations = markdown(text, filename)
  if (!conversations.length || conversations.length > limits.conversations || conversations.reduce((n, c) => n + c.messages.length, 0) > limits.messages) throw new Error('没有可用正文，或导入会话/消息数量超过上限')
  const fingerprint = digest(text)
  return batchSchema.parse({ version: 1, id: `batch-${fingerprint.slice(0, 32)}`, filename, fingerprint, createdAt: new Date().toISOString(), conversations, warnings: [...new Set(conversations.flatMap(c => c.warnings))], applied: [] })
}
