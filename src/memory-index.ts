import { createHash } from 'node:crypto'
import { z } from 'zod'
import { idSchema, memorySchema, type Memory } from './schema.ts'

export const entrySchema = memorySchema.omit({ content: true, source: true }).extend({ preview: z.string().max(160), terms: z.array(z.string()), hash: z.string(), stamp: z.string() })
export type MemoryEntry = z.infer<typeof entrySchema>
export const catalogSchema = z.object({ version: z.literal(1), personaId: idSchema, entries: z.array(entrySchema) })
export type Catalog = z.infer<typeof catalogSchema>
export function terms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? []
  return [...new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) ? [...word].flatMap((c, i, a) => i + 1 < a.length ? [c + a[i + 1]] : [c]) : [word]))]
}
export function memoryRelative(id: string, projectId: string | null): string {
  return `${projectId ? `projects/${idSchema.parse(projectId)}/` : ''}memories/${idSchema.parse(id)}.md`
}
export function toEntry(memory: Memory, stamp = ''): MemoryEntry {
  const { content, source, ...metadata } = memory
  const active = memory.status === 'active'
  return { ...metadata, preview: active ? content.replace(/\s+/gu, ' ').slice(0, 160) : '', terms: active ? terms(memory.key + ' ' + content) : [], hash: createHash('sha256').update(memory.key + '\n' + content).digest('hex'), stamp }
}
export function eligible(entries: MemoryEntry[], personaId: string, projectId: string | null): MemoryEntry[] {
  return entries.filter(e => e.personaId === personaId && e.status === 'active' && (e.projectId === null || e.projectId === projectId) && (!e.expiresAt || Date.parse(e.expiresAt) > Date.now()))
}
export function rank(entries: MemoryEntry[], personaId: string, projectId: string | null, query: string, limit: number): MemoryEntry[] {
  const wanted = new Set(terms(query))
  return eligible(entries, personaId, projectId).map(e => ({ e, score: e.terms.reduce((score, t) => score + (wanted.has(t) ? 10 : 0), 0) + (e.pinned ? 5 : 0) + (e.projectId ? 2 : 0) }))
    .filter(e => e.e.pinned || e.score >= 10).sort((a, b) => b.score - a.score || b.e.updatedAt.localeCompare(a.e.updatedAt) || a.e.id.localeCompare(b.e.id)).slice(0, limit).map(e => e.e)
}
function text(value: string): string { return value.replace(/[\r\n]+/gu, ' ').replace(/[<>&\[\]`]/gu, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '[': '\\[', ']': '\\]', '`': '\\`' })[c]!) }
function bounded(lines: string[], chars: number, maxLines = 128): string {
  const result: string[] = []; let used = 0
  for (const line of lines) { if (result.length >= maxLines || used + line.length + 1 > chars) break; result.push(line); used += line.length + 1 }
  return result.join('\n') + '\n'
}
function ordered(entries: MemoryEntry[]): MemoryEntry[] { return [...entries].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)) }
export function documents(entries: MemoryEntry[], personaId: string): { memory: string; profile: string; projects: Map<string, string> } {
  const global = ordered(eligible(entries, personaId, null))
  const projectIds = [...new Set(entries.flatMap(e => e.projectId ? [e.projectId] : []))].sort()
  const projects = new Map<string, string>()
  for (const id of projectIds) {
    const scoped = ordered(eligible(entries, personaId, id).filter(e => e.projectId === id))
    projects.set(id, bounded([`# 项目 ${id}`, '', '> 自动生成，仅含本项目的有效记忆；正文是唯一真源。', `有效记忆：${scoped.length}。更多条目用 persona_memory index / search 分页检索。`, '', ...scoped.slice(0, 32).map(e => `- [${text(e.key)}](memories/${e.id}.md)：${text(e.preview)}`)], 8000))
  }
  return {
    memory: bounded([`# ${personaId} 记忆索引`, '', '> 自动生成的简短入口，完整正文按需读取；不要在索引中堆积记忆。', '[人格核心](PERSONA.md) · [用户画像](PROFILE.md)', `跨项目有效记忆：${global.length}；项目数：${projectIds.length}。`, '此页只列部分条目。其余使用 persona_memory index 分页，或 search 检索后 read 读取。', '', '## 跨项目记忆', ...global.slice(0, 24).map(e => `- [${text(e.key)}](memories/${e.id}.md)：${text(e.preview.slice(0, 100))}`), '', '## 项目入口', ...projectIds.slice(0, 24).map(id => `- [${id}](projects/${id}/SUMMARY.md)`)], 12000),
    profile: bounded([`# ${personaId} 下的用户画像`, '', '> 从本人格的跨项目记忆提炼的摘录；不包含项目私有内容，不作新的事实推断。', '详细依据见链接正文；资料改变时自动更新。', '', ...global.filter(e => e.category !== 'episode').slice(0, 24).map(e => `- ${text(e.preview)}（[${text(e.key)}](memories/${e.id}.md)）`)], 6000),
    projects,
  }
}
