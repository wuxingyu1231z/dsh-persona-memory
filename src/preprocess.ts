/** Browser/CLI shared, local-only preprocessing. Visible text and graph identities are preserved. */
import { branchSelection, type BranchSelection } from './import-branches.ts'
export interface PreparedConversation {
  id: string; title: string; sourceId: string; text: string; format: 'json' | 'markdown';
  messages: number; branches: number; characters: number; warnings: string[]
}
export interface PreparedHistory {
  filename: string; originalCharacters: number; preparedCharacters: number; conversations: PreparedConversation[];
  removedThinkingCharacters: number; removedFragments: number; skipped: { index: number; title: string; reason: string }[]
}
type Obj = Record<string, unknown>
function object(value: unknown): Obj | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : undefined }
const stampKeys = ['create_time', 'inserted_at', 'created_at', 'timestamp'] as const
function stamps(source: Obj): Obj { return Object.fromEntries(stampKeys.flatMap(key => typeof source[key] === 'string' || typeof source[key] === 'number' ? [[key, source[key]]] : [])) }

export function preprocessHistory(filename: string, input: string): PreparedHistory {
  if (input.length > 64000000) throw new Error('原始文件超过 6400 万字符，请先拆分导出。')
  const text = input.replace(/^\uFEFF/u, '')
  const result: PreparedHistory = { filename, originalCharacters: input.length, preparedCharacters: 0, conversations: [], removedThinkingCharacters: 0, removedFragments: 0, skipped: [] }
  if (!/^[\s]*[\[{]/u.test(text)) {
    if (text.length > 4000000) throw new Error('单个 Markdown 对话超过 400 万字符，请先按完整轮次拆分。')
    result.conversations = [{ id: 'local-0', title: filename, sourceId: '', text, format: 'markdown', messages: 0, branches: 1, characters: text.length, warnings: [] }]
    result.preparedCharacters = text.length; return result
  }
  const raw: unknown = JSON.parse(text), root = object(raw)
  const list = Array.isArray(raw) ? raw : Array.isArray(root?.conversations) ? root.conversations : [raw]
  if (list.length > 10000) throw new Error('导出超过 10,000 个会话，请先分批。')
  let totalNodes = 0
  for (let index = 0; index < list.length; index++) {
    const conversation = object(list[index]), title = String(conversation?.title ?? conversation?.name ?? `对话 ${index + 1}`).slice(0, 300)
    try {
      if (!conversation) throw new Error('会话不是对象')
      const warnings = new Set<string>()
      const prior = object(conversation.personaMemoryPreprocessing)
      if (prior?.version === 1 && Array.isArray(prior.warnings)) for (const note of prior.warnings.slice(0, 16)) if (typeof note === 'string') warnings.add(note.slice(0, 300))
      function message(raw: unknown): Obj | null {
        const m = object(raw); if (!m) return null
        const identity = { ...(m.id !== undefined ? { id: String(m.id).slice(0, 300) } : {}), ...stamps(m) }
        if (Array.isArray(m.fragments)) {
          const fragments: Obj[] = [], roles = new Set<string>()
          for (const rawFragment of m.fragments) {
            const f = object(rawFragment); if (!f) throw new Error('消息片段不是对象')
            if (f.type !== 'REQUEST' && f.type !== 'RESPONSE') {
              result.removedFragments++
              if (f.type === 'THINK' && typeof f.content === 'string') result.removedThinkingCharacters += f.content.length
              warnings.add('预处理已移除思考过程、工具活动及附件，仅保留用户与助手可见正文。'); continue
            }
            if (typeof f.content !== 'string') throw new Error('可见正文不是字符串')
            roles.add(f.type); fragments.push({ type: f.type, content: f.content })
          }
          if (roles.size > 1) throw new Error('同一节点混合用户与助手角色')
          return fragments.some(f => String(f.content).trim()) ? { ...identity, fragments } : null
        }
        const role = m.role ?? object(m.author)?.role
        if (role !== 'user' && role !== 'assistant') { warnings.add('预处理已移除系统消息、工具角色和未知角色。'); return null }
        if (role === 'assistant' && (['analysis', 'commentary'].includes(String(m.channel)) || typeof m.recipient === 'string' && m.recipient !== 'all')) {
          result.removedFragments++; warnings.add('预处理已移除助手的推理通道与工具调用消息。'); return null
        }
        let content = typeof m.content === 'string' ? m.content : ''
        const structured = object(m.content)
        if (structured) {
          if (structured.content_type && !['text', 'multimodal_text'].includes(String(structured.content_type))) { warnings.add('非正文类型已跳过。'); return null }
          if (Array.isArray(structured.parts)) {
            content = structured.parts.filter(p => typeof p === 'string').join('\n')
            if (structured.parts.some(p => typeof p !== 'string')) warnings.add('图片、音频和附件本体未导入。')
          } else if (typeof structured.text === 'string') content = structured.text
        }
        return content.trim() ? { ...identity, role, content } : null
      }
      const normalized: Obj = { ...(conversation.id !== undefined || conversation.conversation_id !== undefined ? { id: String(conversation.id ?? conversation.conversation_id).slice(0, 300) } : {}), title }
      let messages = 0, branches = 1
      let selected: BranchSelection | undefined
      if (conversation.mapping) {
        const source = object(conversation.mapping); if (!source) throw new Error('mapping 不是对象')
        const keys = Object.keys(source); totalNodes += keys.length
        if (!keys.length || keys.length > 20000 || totalNodes > 200000) throw new Error('对话图节点超过预处理上限')
        const cleaned: Record<string, Obj> = Object.create(null), parents = new Set<string>()
        for (const key of keys) {
          const n = object(source[key]); if (!n) throw new Error('对话图节点不是对象')
          const parent = n.parent === null || n.parent === undefined ? null : String(n.parent)
          if (parent !== null) { if (!Object.hasOwn(source, parent)) throw new Error('分支引用缺失节点'); parents.add(parent) }
          const visible = message(n.message); if (visible) messages++
          cleaned[key] = { parent, message: visible }
        }
        const valid = new Set<string>()
        for (const key of keys) {
          const path = new Set<string>(); let at: string | null = key
          while (at !== null && !valid.has(at)) { if (path.has(at)) throw new Error('对话图存在循环'); path.add(at); at = cleaned[at].parent as string | null }
          for (const id of path) valid.add(id)
        }
        const current = conversation.current_node === null || conversation.current_node === undefined ? null : String(conversation.current_node)
        if (current !== null && !Object.hasOwn(cleaned, current)) throw new Error('current_node 指向无效节点')
        selected = branchSelection(prior?.branchSelection, cleaned)
        const tips = selected?.tips ?? [...new Set([...(current !== null ? [current] : []), ...keys.filter(k => !parents.has(k))])]
        branches = tips.filter(tip => { let at: string | null = tip; while (at !== null) { if (cleaned[at].message) return true; at = cleaned[at].parent as string | null }; return false }).length
        normalized.mapping = cleaned; if (current !== null) normalized.current_node = current
      } else {
        const source = conversation.messages ?? conversation.chat_messages
        if (!Array.isArray(source)) throw new Error('不是聊天记录：需要 mapping 或 messages（user.json 等账户文件无需导入）')
        totalNodes += source.length; if (totalNodes > 200000) throw new Error('消息数量超过预处理上限')
        // Keep original message positions in generated ids when non-text nodes are removed.
        normalized.messages = source.flatMap((rawMessage, position) => { const m = message(rawMessage); return m ? [{ ...m, id: m.id ?? `message-${position}` }] : [] })
        messages = (normalized.messages as Obj[]).length
      }
      if (!messages || !branches) throw new Error('没有可见用户/助手正文')
      normalized.personaMemoryPreprocessing = { version: 1, warnings: [...warnings], ...(selected ? { branchSelection: selected } : {}) }
      const output = JSON.stringify(normalized)
      result.preparedCharacters += output.length
      result.conversations.push({ id: `local-${index}`, title, sourceId: String(normalized.id ?? ''), text: output, format: 'json', messages, branches, characters: output.length, warnings: [...warnings] })
    } catch (error) { result.skipped.push({ index, title, reason: error instanceof Error ? error.message : '预处理失败' }) }
  }
  if (!result.conversations.length) throw new Error(result.skipped[0]?.reason ?? '没有可用对话')
  return result
}

interface TransportConversation extends PreparedConversation { expandedMessages: number; expandedCharacters: number }
const maxPartCharacters = 4000000, maxExpandedCharacters = 7500000, maxMessages = 20000

function messageSize(message: Obj, fallbackId: string): number {
  const text = Array.isArray(message.fragments) ? message.fragments.map(f => String(object(f)?.content ?? '')).join('\n\n') : String(message.content ?? '')
  return JSON.stringify({ id: String(message.id ?? fallbackId).slice(0, 300), role: 'assistant', text, at: 0 }).length + 64
}

/** Split transport records, never the dialogue text or its original branch identities. */
function splitBranches(conversation: PreparedConversation): TransportConversation[] {
  const basic = { ...conversation, expandedMessages: conversation.messages, expandedCharacters: conversation.characters + conversation.messages * 400 + 12000 }
  if (conversation.format !== 'json') return [basic]
  const raw = JSON.parse(conversation.text) as Obj, mapping = object(raw.mapping)
  if (!mapping) return [basic]
  const prior = object(raw.personaMemoryPreprocessing)
  const selection = branchSelection(prior?.branchSelection, mapping)
  const keys = Object.keys(mapping), parents = new Set(keys.flatMap(key => { const parent = object(mapping[key])!.parent; return parent === null ? [] : [String(parent)] }))
  const leaves = keys.filter(key => !parents.has(key))
  const current = raw.current_node === undefined || raw.current_node === null ? null : String(raw.current_node)
  const preferred = selection ? selection.preferred : current ?? leaves[0] ?? null
  const tips = selection?.tips ?? [...new Set([...(current !== null ? [current] : []), ...leaves])]
  const costs = new Map<string, { messages: number; characters: number }>()
  function cost(tip: string): { messages: number; characters: number } {
    const path: string[] = []; let at: string | null = tip
    while (at !== null && !costs.has(at)) { path.push(at); at = object(mapping![at])!.parent as string | null }
    let value = at === null ? { messages: 0, characters: 0 } : costs.get(at)!
    for (const id of path.reverse()) {
      const message = object(object(mapping![id])!.message)
      value = { messages: value.messages + (message ? 1 : 0), characters: value.characters + (message ? messageSize(message, id) : 0) }
      costs.set(id, value)
    }
    return value
  }
  const visible = tips.filter(tip => cost(tip).messages > 0)
  function fragment(chosen: string[]): TransportConversation {
    // Named exports can be pruned to the exact ancestor closure. Anonymous exports retain
    // their original graph so the Host can reproduce their existing content-derived identity.
    let subset = mapping!
    if (raw.id !== undefined || raw.conversation_id !== undefined) {
      const included = new Set<string>()
      for (const tip of chosen) { let at: string | null = tip; while (at !== null && !included.has(at)) { included.add(at); at = object(mapping![at])!.parent as string | null } }
      subset = Object.fromEntries(keys.filter(key => included.has(key)).map(key => [key, mapping![key]]))
    }
    const sliced: Obj = { ...raw, mapping: subset, personaMemoryPreprocessing: { ...prior, branchSelection: { tips: chosen, preferred } } }
    if (current !== null && !Object.hasOwn(subset, current)) delete sliced.current_node
    const text = JSON.stringify(sliced)
    return { ...conversation, text, characters: text.length, branches: chosen.length,
      expandedMessages: chosen.reduce((n, tip) => n + cost(tip).messages, 0),
      expandedCharacters: chosen.reduce((n, tip) => n + cost(tip).characters + 12000, 0) }
  }
  const fits = (record: TransportConversation) => record.branches <= 16 && record.characters <= maxPartCharacters && record.expandedMessages <= maxMessages && record.expandedCharacters <= maxExpandedCharacters
  const whole = { ...basic, expandedMessages: visible.reduce((n, tip) => n + cost(tip).messages, 0), expandedCharacters: visible.reduce((n, tip) => n + cost(tip).characters + 12000, 0) }
  if (tips.length === visible.length && fits(whole)) return [whole]
  const records: TransportConversation[] = []; let chosen: string[] = [], candidate: TransportConversation | undefined
  for (const tip of visible) {
    const next = fragment([...chosen, tip])
    if (chosen.length && !fits(next)) { records.push(candidate!); chosen = []; candidate = undefined }
    chosen.push(tip); candidate = chosen.length === 1 ? fragment(chosen) : next
    if (!fits(candidate)) throw new Error('单个分支的完整正文超过单片容量，请减少导出内容；不会截断正文。')
  }
  if (candidate) records.push(candidate)
  return records
}

function serializeGroup(prepared: TransportConversation[]): { text: string; format: 'json' | 'markdown' } {
  if (!prepared.length || prepared.length > 32) throw new Error('自动分片需包含 1 至 32 个会话')
  if (prepared.reduce((n, c) => n + c.branches, 0) > 128) throw new Error('自动分片的分支数量超过上限')
  if (prepared.some(c => c.branches > 16)) throw new Error('自动分支分片超过上限')
  if (prepared.some(c => c.format === 'markdown') && prepared.length > 1) throw new Error('Markdown 请逐个导入')
  const text = prepared.length === 1 ? prepared[0].text : `[${prepared.map(c => c.text).join(',')}]`
  if (text.length > 4000000) throw new Error('单个超长对话超过 400 万字符，需先按完整轮次拆分。')
  return { text, format: prepared[0].format }
}

/** Automatically partitions the entire export; never asks the user to select an import subset. */
export function historyParts(history: PreparedHistory): { text: string; format: 'json' | 'markdown' }[] {
  if (history.skipped.length) throw new Error(`${history.skipped.length} 个会话无法处理，整包未导入：${history.skipped.slice(0, 3).map(s => `${s.title}：${s.reason}`).join('；')}`)
  if (history.conversations.reduce((n, c) => n + c.branches, 0) > 10000) throw new Error('整包超过 10,000 个分支，请先拆分导出。')
  const parts: { text: string; format: 'json' | 'markdown' }[] = [], current: TransportConversation[] = []
  for (const conversation of history.conversations.flatMap(splitBranches)) {
    serializeGroup([conversation])
    const size = current.reduce((n, c) => n + c.characters + 1, 2)
    if (current.length && (current.length >= 32 || size + conversation.characters > 2000000 || current.reduce((n, c) => n + c.branches, 0) + conversation.branches > 128
      || current.reduce((n, c) => n + c.expandedMessages, 0) + conversation.expandedMessages > maxMessages
      || current.reduce((n, c) => n + c.expandedCharacters, 0) + conversation.expandedCharacters > maxExpandedCharacters)) {
      parts.push(serializeGroup(current)); current.length = 0
    }
    current.push(conversation)
  }
  if (current.length) parts.push(serializeGroup(current))
  if (parts.length > 1024) throw new Error('自动拆分超过 1024 个传输分片，请减少本次导出内容。')
  return parts
}
