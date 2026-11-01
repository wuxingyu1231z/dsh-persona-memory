import { z } from 'zod'
import { MemoryStore, recall } from './store.ts'
import { digest } from './import-parser.ts'
import type { Memory, ResolvedConfig } from './schema.ts'

const vector = z.array(z.number().finite()).min(1).max(8192)
const cacheSchema = z.object({ personaId: z.string(), projectId: z.string().nullable(), modelKey: z.string(), entries: z.array(z.object({ id: z.string(), hash: z.string(), vector })) })
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Embedding 维度不一致')
  let dot = 0, x = 0, y = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2 }
  return x && y ? dot / Math.sqrt(x * y) : 0
}
/** Optional HTTP embeddings. The caller filters scope before any text leaves the Host. */
export class SemanticMemory {
  constructor(private readonly store: MemoryStore, private readonly config: ResolvedConfig, private readonly request: typeof fetch = fetch) {}
  private async embed(input: string[], signal: AbortSignal): Promise<number[][]> {
    const cfg = this.config.embedding!
    const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined
    if (cfg.apiKeyEnv && !key) throw new Error('Embedding 凭据环境变量未设置')
    const response = await this.request(cfg.endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model: cfg.model, input, ...(cfg.provider === 'ollama' ? { truncate: false } : {}) }), signal: AbortSignal.any([signal, AbortSignal.timeout(cfg.timeoutMs)]) })
    if (!response.ok) throw new Error('Embedding 服务请求失败')
    const reader = response.body?.getReader(); if (!reader) throw new Error('Embedding 响应为空')
    let text = ''; const decoder = new TextDecoder()
    try { while (true) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value, { stream: true }); if (text.length > 4000000) throw new Error('Embedding 响应过大') } text += decoder.decode() }
    finally { await reader.cancel() }
    const data: unknown = JSON.parse(text)
    const vectors = cfg.provider === 'ollama'
      ? z.object({ embeddings: z.array(vector) }).parse(data).embeddings
      : z.object({ data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: vector })) }).parse(data).data.sort((a, b) => a.index - b.index).map((item, i) => { if (item.index !== i) throw new Error('Embedding 响应索引不连续'); return item.embedding })
    if (vectors.length !== input.length || vectors.some(v => v.length !== vectors[0]?.length || !v.some(n => n !== 0))) throw new Error('Embedding 响应数量或维度无效')
    return vectors
  }
  async search(memories: Memory[], personaId: string, projectId: string | null, query: string, signal: AbortSignal): Promise<Memory[]> {
    const lexical = recall(memories, personaId, projectId, query, this.config.recallLimit)
    if (!this.config.embedding || !query.trim()) return lexical
    const eligible = memories.filter(m => m.status === 'active' && m.personaId === personaId && (m.projectId === null || m.projectId === projectId) && (!m.expiresAt || Date.parse(m.expiresAt) > Date.now()))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 256)
    if (!eligible.length) return lexical
    const cfg = this.config.embedding
    const modelKey = digest(`${cfg.provider}:${cfg.endpoint}:${cfg.model}`)
    const id = `vectors-${digest(`${personaId}:${projectId}:${modelKey}`).slice(0, 32)}`
    const old = await this.store.readArtifact('semantic', id, cacheSchema)
    const entries = eligible.flatMap(m => { const hash = digest(m.key + '\n' + m.content); const cached = old?.entries.find(e => e.id === m.id && e.hash === hash); return cached ? [cached] : [] })
    const missing = eligible.filter(m => !entries.some(e => e.id === m.id))
    for (let i = 0; i < missing.length; i += cfg.batchSize) {
      signal.throwIfAborted()
      const batch = missing.slice(i, i + cfg.batchSize)
      const vectors = await this.embed(batch.map(m => m.key + '\n' + m.content), signal)
      batch.forEach((m, j) => entries.push({ id: m.id, hash: digest(m.key + '\n' + m.content), vector: vectors[j] }))
    }
    const cache = await this.store.updateArtifact('semantic', id, cacheSchema, async () => {
      // Recheck under the writer lock: a late embedding must not resurrect a forgotten vector.
      const current = await this.store.index(personaId)
      return { personaId, projectId, modelKey, entries: entries.filter(e => current.some(m => m.id === e.id && m.status === 'active' && m.hash === e.hash && (!m.expiresAt || Date.parse(m.expiresAt) > Date.now()))) }
    })
    const [q] = await this.embed([query.slice(-8000)], signal)
    const current = await this.store.index(personaId)
    const valid = (m: Memory) => current.some(c => c.id === m.id && c.status === 'active' && c.revision === m.revision && (!c.expiresAt || Date.parse(c.expiresAt) > Date.now()))
    const semantic = cache.entries.map(e => ({ id: e.id, score: cosine(q, e.vector) })).filter(e => e.score >= cfg.minSimilarity).sort((a, b) => b.score - a.score)
    const scores = new Map<string, number>()
    lexical.forEach((m, i) => scores.set(m.id, 1 / (30 + i)))
    semantic.forEach((m, i) => scores.set(m.id, (scores.get(m.id) ?? 0) + 1.5 / (30 + i)))
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => eligible.find(m => m.id === id) ?? lexical.find(m => m.id === id)!).filter(valid).slice(0, this.config.recallLimit)
  }
  async forget(personaId: string, memoryId: string): Promise<void> {
    for (const id of await this.store.artifactIds('semantic')) {
      const cache = await this.store.readArtifact('semantic', id, cacheSchema)
      if (cache?.personaId === personaId && cache.entries.some(e => e.id === memoryId)) await this.store.updateArtifact('semantic', id, cacheSchema, current => ({ ...current!, entries: current!.entries.filter(e => e.id !== memoryId) }))
    }
  }
}
