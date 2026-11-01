import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises'
import lockfile from 'proper-lockfile'
import { join, resolve, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { dump, load } from 'js-yaml'
import { z } from 'zod'
import { idSchema, personaSchema, memorySchema, personaInputSchema, memoryInputSchema, journalSchema, type Persona, type Memory, type LearningJournal, type Candidate, type LearningJob, type Proposal, type ResolvedConfig } from './schema.ts'
import { templates } from './templates.ts'
import { catalogSchema, documents, memoryRelative, rank, toEntry, type Catalog, type MemoryEntry } from './memory-index.ts'
export type { MemoryEntry } from './memory-index.ts'

function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
async function atomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temp, text, { flag: 'wx', mode: 0o600 }); await rename(temp, path) }
  finally { await unlink(temp).catch(error => { if (!missing(error)) throw error }) }
}
function document(value: object, content: string): string { return `---\n${dump(value, { lineWidth: -1, noRefs: true })}---\n\n${content.trim()}\n` }
function parseDocument(text: string): { metadata: object; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error('记忆文件缺少 YAML 元数据')
  return { metadata: z.record(z.string(), z.unknown()).parse(load(match[1])), content: match[2].trim() }
}
export function projectId(cwd: string | undefined): string | null {
  return cwd ? `p-${createHash('sha256').update(process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd)).digest('hex').slice(0, 24)}` : null
}
function tokens(text: string): Set<string> {
  const words = text.toLocaleLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? []
  return new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) ? [...word].flatMap((ch, i, arr) => i + 1 < arr.length ? [ch + arr[i + 1]] : [ch]) : [word]))
}
export function recall(memories: Memory[], personaId: string, project: string | null, query: string, limit: number): Memory[] {
  const wanted = tokens(query)
  return memories.filter(m => m.status === 'active' && (!m.expiresAt || Date.parse(m.expiresAt) > Date.now()) && m.personaId === personaId && (m.projectId === null || m.projectId === project))
    .map(m => { const terms = tokens(m.key + ' ' + m.content); const hits = [...wanted].filter(t => terms.has(t)).length; return { m, score: hits * 10 + (m.pinned ? 5 : 0) + (m.projectId ? 2 : 0) } })
    .filter(x => x.m.pinned || x.score >= 10)
    .sort((a, b) => b.score - a.score || b.m.updatedAt.localeCompare(a.m.updatedAt)).slice(0, limit).map(x => x.m)
}
export function topicKey(key: string): string { return key.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '') }
export function topicHash(key: string): string { return createHash('sha256').update(topicKey(key)).digest('hex') }
export function directIntent(text: string): boolean {
  return /记住|以后|一直|长期|我(?:喜欢|偏好|习惯)|remember|from now on|always|i prefer/iu.test(text)
    && !/假设|例如|示例|引用|比如|suppose|example|quot(?:e|ing)/iu.test(text)
    && !/不要(?:再)?(?:记住|保存|记录)|别(?:记住|保存)|do not (?:remember|save)/iu.test(text)
}

/** Markdown is authoritative; all indexes can be rebuilt. Mutations use one cross-process lock. */
export class MemoryStore {
  readonly root: string
  private readonly catalogs = new Map<string, Catalog>()
  constructor(root: string, private readonly lockWaitMs = 5000, private readonly lockStaleMs = 30000) { this.root = resolve(root) }
  private path(personaId: string, ...parts: string[]): string { return join(this.root, 'personas', idSchema.parse(personaId), ...parts) }
  private memoryPath(personaId: string, id: string, project: string | null): string { return this.path(personaId, memoryRelative(id, project)) }
  protected async readMemoryFile(path: string): Promise<Memory> {
    const doc = parseDocument(await readFile(path, 'utf8'))
    return memorySchema.parse({ ...doc.metadata, content: doc.content })
  }
  private async inventory(personaId: string): Promise<{ id: string; project: string | null; stamp: string }[]> {
    const result: { id: string; project: string | null; stamp: string }[] = []
    const scan = async (project: string | null) => {
      const folder = project ? this.path(personaId, 'projects', project, 'memories') : this.path(personaId, 'memories')
      const files = await readdir(folder, { withFileTypes: true }).catch(error => { if (missing(error)) return []; throw error })
      for (const file of files) if (file.isFile() && /^[a-z0-9_-]+\.md$/.test(file.name)) {
        const info = await stat(join(folder, file.name), { bigint: true })
        result.push({ id: idSchema.parse(file.name.slice(0, -3)), project, stamp: `${info.size}:${info.mtimeNs}:${info.ctimeNs}` })
      }
    }
    await scan(null)
    const dirs = await readdir(this.path(personaId, 'projects'), { withFileTypes: true }).catch(error => { if (missing(error)) return []; throw error })
    for (const dir of dirs) if (dir.isDirectory() && idSchema.safeParse(dir.name).success) await scan(dir.name)
    return result.sort((a, b) => (a.project ?? '').localeCompare(b.project ?? '') || a.id.localeCompare(b.id))
  }
  /** Metadata/terms only; unchanged Markdown bodies are not read. Safe inside the writer lock. */
  async index(personaId: string): Promise<MemoryEntry[]> {
    idSchema.parse(personaId)
    let old = this.catalogs.get(personaId)
    if (!old) {
      try { old = catalogSchema.parse(JSON.parse(await readFile(join(this.root, 'state', 'catalogs', `${personaId}.json`), 'utf8'))); if (old.personaId !== personaId) old = undefined }
      catch (error) { if (!missing(error) && !(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error }
    }
    const cached = new Map(old?.entries.map(e => [`${e.projectId}:${e.id}`, e]))
    const entries: MemoryEntry[] = []
    for (const file of await this.inventory(personaId)) {
      const previous = cached.get(`${file.project}:${file.id}`)
      if (previous?.stamp === file.stamp && previous.personaId === personaId) { entries.push(previous); continue }
      const memory = await this.readMemoryFile(this.memoryPath(personaId, file.id, file.project))
      if (memory.personaId !== personaId || memory.id !== file.id || memory.projectId !== file.project) throw new Error('记忆归属与文件路径不一致')
      entries.push(toEntry(memory, file.stamp))
    }
    if (new Set(entries.map(e => e.id)).size !== entries.length) throw new Error('同一人格的记忆 ID 重复')
    this.catalogs.set(personaId, { version: 1, personaId, entries })
    return entries
  }
  private async derivedUnlocked(personaId: string): Promise<MemoryEntry[]> {
    const entries = await this.index(personaId)
    const generated = documents(entries, personaId)
    const changed = async (path: string, content: string) => {
      const old = await readFile(path, 'utf8').catch(error => { if (missing(error)) return undefined; throw error })
      if (old !== content) await atomic(path, content)
    }
    await changed(this.path(personaId, 'MEMORY.md'), generated.memory)
    await changed(this.path(personaId, 'PROFILE.md'), generated.profile)
    for (const [id, summary] of generated.projects) await changed(this.path(personaId, 'projects', id, 'SUMMARY.md'), summary)
    const dirs = await readdir(this.path(personaId, 'projects'), { withFileTypes: true }).catch(error => { if (missing(error)) return []; throw error })
    for (const dir of dirs) if (dir.isDirectory() && idSchema.safeParse(dir.name).success && !generated.projects.has(dir.name)) await changed(this.path(personaId, 'projects', dir.name, 'SUMMARY.md'), `# 项目 ${dir.name}\n\n当前没有有效记忆。\n`)
    await changed(join(this.root, 'state', 'catalogs', `${personaId}.json`), JSON.stringify({ version: 1, personaId, entries }) + '\n')
    return entries
  }
  async synchronize(personaId: string): Promise<MemoryEntry[]> { return this.lock(() => this.derivedUnlocked(personaId)) }
  private async migrateUnlocked(personaId: string): Promise<void> {
    const folder = this.path(personaId, 'memories')
    const files = await readdir(folder).catch(error => { if (missing(error)) return []; throw error })
    const plan: { from: string; to: string; content: string; exists: boolean }[] = []
    for (const file of files.filter(f => /^[a-z0-9_-]+\.md$/.test(f))) {
      const from = join(folder, file), memory = await this.readMemoryFile(from)
      if (memory.personaId !== personaId || file !== `${memory.id}.md`) throw new Error('记忆归属与文件路径不一致')
      if (!memory.projectId) continue
      const to = this.memoryPath(personaId, memory.id, memory.projectId)
      let exists = false
      try { const other = await this.readMemoryFile(to); exists = true; if (JSON.stringify(other) !== JSON.stringify(memory)) throw new Error('项目记忆迁移冲突，两个原文件均已保留') }
      catch (error) { if (!missing(error)) throw error }
      plan.push({ from, to, content: await readFile(from, 'utf8'), exists })
    }
    for (const item of plan) { if (!item.exists) await atomic(item.to, item.content); await unlink(item.from) }
  }
  /** Load only selected bodies, respecting the revision captured at the turn boundary. */
  async readEntry(entry: MemoryEntry): Promise<Memory | undefined> {
    const path = this.memoryPath(entry.personaId, entry.id, entry.projectId)
    let current: Memory
    try { current = await this.readMemoryFile(path) } catch (error) { if (missing(error)) return; throw error }
    if (current.id !== entry.id || current.personaId !== entry.personaId || current.projectId !== entry.projectId) throw new Error('记忆归属与文件路径不一致')
    if (current.status !== 'active') return
    if (current.revision === entry.revision) return toEntry(current).hash === entry.hash ? current : undefined
    try {
      const old = await this.readMemoryFile(this.path(entry.personaId, 'revisions', `${entry.id}-${entry.revision}.md`))
      if (old.id === entry.id && old.personaId === entry.personaId && old.projectId === entry.projectId && toEntry(old).hash === entry.hash) return { ...old, status: 'active' }
    } catch (error) { if (!missing(error)) throw error }
  }
  async search(personaId: string, project: string | null, query: string, limit: number, entries?: MemoryEntry[]): Promise<Memory[]> {
    const selected = rank(entries ?? await this.index(personaId), personaId, project, query, limit)
    return (await Promise.all(selected.map(e => this.readEntry(e)))).filter((m): m is Memory => !!m)
  }
  async getMemory(personaId: string, project: string | null, id: string): Promise<Memory | undefined> {
    id = idSchema.parse(id)
    const entry = (await this.index(personaId)).find(e => e.id === id && e.status === 'active' && (e.projectId === null || e.projectId === project))
    return entry ? this.readEntry(entry) : undefined
  }
  private async lock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true })
    let compromised: Error | undefined
    const release = await lockfile.lock(this.root, { lockfilePath: join(this.root, '.writer-lock'), stale: this.lockStaleMs, update: Math.floor(this.lockStaleMs / 3), retries: { retries: Math.ceil(this.lockWaitMs / 25), minTimeout: 25, maxTimeout: 25, factor: 1 }, onCompromised: error => { compromised = error } })
    try { const result = await operation(); if (compromised) throw compromised; return result }
    finally { if (!compromised) await release() }
  }
  async initialize(): Promise<void> {
    await this.lock(async () => {
      let migrated = false
      try { const layout = JSON.parse(await readFile(join(this.root, 'state', 'layout.json'), 'utf8')); if (layout.version !== 2) throw new Error('不支持的记忆目录版本'); migrated = true } catch (error) { if (!missing(error)) throw error }
      for (const item of templates) {
        try { await this.getPersona(item.id) } catch (error) {
          if (!missing(error)) throw error
          const persona = { ...item, revision: 1, updatedAt: new Date().toISOString() }
          await this.writePersona(persona)
        }
      }
      for (const persona of await this.listPersonas()) { if (!migrated) await this.migrateUnlocked(persona.id); await this.derivedUnlocked(persona.id) }
      await atomic(join(this.root, 'state', 'layout.json'), JSON.stringify({ version: 2 }) + '\n')
    })
  }
  async listPersonas(): Promise<Persona[]> {
    const dirs = await readdir(join(this.root, 'personas'), { withFileTypes: true })
    return Promise.all(dirs.filter(d => d.isDirectory() && idSchema.safeParse(d.name).success).map(d => this.getPersona(d.name)))
  }
  async getPersona(id: string): Promise<Persona> {
    const doc = parseDocument(await readFile(this.path(id, 'PERSONA.md'), 'utf8'))
    return personaSchema.parse({ ...doc.metadata, prompt: doc.content })
  }
  private async writePersona(persona: Persona): Promise<void> {
    const { prompt, ...meta } = persona
    await atomic(this.path(persona.id, 'PERSONA.md'), document(meta, prompt))
  }
  async savePersona(input: z.infer<typeof personaInputSchema>, expectedRevision: number): Promise<Persona> {
    input = personaInputSchema.parse(input)
    return this.lock(async () => {
      let current: Persona | undefined
      try { current = await this.getPersona(input.id) } catch (error) { if (!missing(error)) throw error }
      if ((current?.revision ?? 0) !== expectedRevision) throw new Error('人格已被修改，请刷新后重试')
      const next: Persona = { ...input, revision: expectedRevision + 1, updatedAt: new Date().toISOString() }
      if (current) await atomic(this.path(input.id, 'revisions', `persona-${current.revision}-${randomUUID()}.md`), document(current, current.prompt))
      await this.writePersona(next)
      await this.derivedUnlocked(next.id)
      return next
    })
  }
  async memories(personaId: string): Promise<Memory[]> {
    return Promise.all((await this.inventory(personaId)).map(async file => {
      const result = await this.readMemoryFile(this.memoryPath(personaId, file.id, file.project))
      if (result.personaId !== personaId || result.id !== file.id || result.projectId !== file.project) throw new Error('记忆归属与文件路径不一致')
      return result
    }))
  }
  async remember(input: z.infer<typeof memoryInputSchema>, expectedRevision: number, source: Memory['source']): Promise<Memory> {
    input = memoryInputSchema.parse(input)
    return this.lock(() => this.rememberUnlocked(input, expectedRevision, source))
  }
  private async rememberUnlocked(input: z.infer<typeof memoryInputSchema>, expectedRevision: number, source: Memory['source']): Promise<Memory> {
      await this.getPersona(input.personaId)
      const entry = (await this.index(input.personaId)).find(m => topicKey(m.key) === topicKey(input.key) && m.projectId === input.projectId && m.status === 'active')
      const current = entry ? await this.readEntry(entry) : undefined
      if ((current?.revision ?? 0) !== expectedRevision) throw new Error('该主题已有新版本，请刷新后再保存')
      const now = new Date().toISOString()
      const next: Memory = memorySchema.parse({ ...input, locked: current?.locked ?? false, expiresAt: current?.expiresAt ?? null, id: current?.id ?? `m-${randomUUID()}`, revision: expectedRevision + 1, status: 'active', source, createdAt: current?.createdAt ?? now, updatedAt: now })
      if (current) {
        const { content, ...meta } = { ...current, status: 'superseded' }
        await atomic(this.path(input.personaId, 'revisions', `${current.id}-${current.revision}.md`), document(meta, content))
      }
      const { content, ...meta } = next
      await atomic(this.memoryPath(input.personaId, next.id, next.projectId), document(meta, content))
      await this.derivedUnlocked(input.personaId)
      return next
  }
  async forget(personaId: string, memoryId: string, expectedRevision: number): Promise<void> {
    idSchema.parse(memoryId)
    await this.lock(async () => {
      const entry = (await this.index(personaId)).find(m => m.id === memoryId && m.status === 'active')
      const current = entry ? await this.readEntry(entry) : undefined
      if (!current || current.revision !== expectedRevision) throw new Error('记忆已变化，请刷新后重试')
      const journal = await this.journal()
      const forgottenAt = Date.now()
      journal.exclusions.push({ personaId, projectId: current.projectId, topicHash: topicHash(current.key), before: forgottenAt, messageIds: current.source.messageIds ?? [] })
      for (const job of journal.jobs) if (job.personaId === personaId && (current.projectId === null || job.projectId === current.projectId) && job.createdAt <= forgottenAt && job.status !== 'complete') { job.messages = []; job.status = 'complete'; job.owner = null }
      for (const candidate of journal.candidates) if (candidate.personaId === personaId && candidate.projectId === current.projectId && topicHash(candidate.proposal.key) === topicHash(current.key)) {
        candidate.status = 'rejected'; candidate.reason = 'forgotten'; candidate.proposal.key = 'forgotten-memory'; candidate.proposal.content = '（已遗忘）'; candidate.proposal.evidence = '（已遗忘）'; candidate.sources = []; candidate.revision++
      }
      // Commit exclusion before removing memory, so a concurrent retry cannot relearn it.
      await this.writeJournal(journal)
      const next = { ...current, key: 'forgotten-memory', pinned: false, status: 'forgotten', content: '', source: { kind: 'user' }, revision: current.revision + 1 }
      await atomic(this.memoryPath(personaId, memoryId, current.projectId), document(next, '（已遗忘）'))
      const revisions = this.path(personaId, 'revisions')
      const files = await readdir(revisions).catch(error => { if (missing(error)) return []; throw error })
      for (const file of files) if (file.startsWith(`${memoryId}-`)) await unlink(join(revisions, file))
      await this.derivedUnlocked(personaId)
    })
  }
  private sessionPath(sessionId: string): string { return join(this.root, 'state', 'sessions', createHash('sha256').update(sessionId).digest('hex') + '.json') }
  async selection(sessionId: string, fallback: string): Promise<string> {
    try { return idSchema.parse(JSON.parse(await readFile(this.sessionPath(sessionId), 'utf8')).personaId) }
    catch (error) { if (missing(error)) return fallback; throw error }
  }
  async select(sessionId: string, personaId: string): Promise<void> {
    await this.getPersona(personaId)
    await this.lock(() => atomic(this.sessionPath(sessionId), JSON.stringify({ personaId }) + '\n'))
  }
  async readArtifact<T>(kind: 'imports' | 'semantic' | 'continuations', id: string, schema: z.ZodType<T>): Promise<T | undefined> {
    try { return schema.parse(JSON.parse(await readFile(join(this.root, kind, `${idSchema.parse(id)}.json`), 'utf8'))) }
    catch (error) { if (missing(error)) return; throw error }
  }
  async writeArtifact(kind: 'imports' | 'semantic' | 'continuations', id: string, value: object): Promise<void> {
    await this.lock(() => atomic(join(this.root, kind, `${idSchema.parse(id)}.json`), JSON.stringify(value) + '\n'))
  }
  async updateArtifact<T>(kind: 'imports' | 'semantic' | 'continuations', id: string, schema: z.ZodType<T>, change: (current: T | undefined) => T | Promise<T>): Promise<T> {
    return this.lock(async () => { const next = schema.parse(await change(await this.readArtifact(kind, id, schema))); await atomic(join(this.root, kind, `${idSchema.parse(id)}.json`), JSON.stringify(next) + '\n'); return next })
  }
  async artifactIds(kind: 'imports' | 'semantic' | 'continuations'): Promise<string[]> {
    try { return (await readdir(join(this.root, kind))).filter(f => /^[a-z0-9][a-z0-9_-]*\.json$/.test(f)).map(f => f.slice(0, -5)) }
    catch (error) { if (missing(error)) return []; throw error }
  }
  async removeImportPart(id: string): Promise<void> {
    idSchema.parse(id)
    if (!id.startsWith('part-')) throw new Error('只能清理导入分片')
    await this.lock(() => unlink(join(this.root, 'imports', id + '.json')).catch(error => { if (!missing(error)) throw error }))
  }
  async journal(): Promise<LearningJournal> {
    try { return journalSchema.parse(JSON.parse(await readFile(join(this.root, 'state', 'learning.json'), 'utf8'))) }
    catch (error) { if (missing(error)) return { version: 1, modes: {}, jobs: [], candidates: [], exclusions: [], cursors: {} }; throw error }
  }
  private async writeJournal(journal: LearningJournal): Promise<void> { await atomic(join(this.root, 'state', 'learning.json'), JSON.stringify(journalSchema.parse(journal), null, 2) + '\n') }
  /** Serialize queue changes with all memory mutations; callbacks must not call locking methods. */
  async updateJournal<T>(change: (journal: LearningJournal) => T | Promise<T>): Promise<T> {
    return this.lock(async () => { const journal = await this.journal(); const result = await change(journal); await this.writeJournal(journal); return result })
  }
  async configureMemory(personaId: string, id: string, revision: number, locked: boolean, expiresAt: string | null): Promise<void> {
    await this.lock(async () => {
      const entry = (await this.index(personaId)).find(m => m.id === id && m.status === 'active')
      const memory = entry ? await this.readEntry(entry) : undefined
      if (!memory || memory.revision !== revision) throw new Error('记忆已变化，请刷新后重试')
      const next = memorySchema.parse({ ...memory, locked, expiresAt, revision: revision + 1, updatedAt: new Date().toISOString() })
      const { content, ...meta } = next
      const { content: oldContent, ...oldMeta } = { ...memory, status: 'superseded' }
      await atomic(this.path(personaId, 'revisions', `${memory.id}-${memory.revision}.md`), document(oldMeta, oldContent))
      await atomic(this.memoryPath(personaId, idSchema.parse(id), memory.projectId), document(meta, content))
      await this.derivedUnlocked(personaId)
    })
  }
  async recordProposal(job: LearningJob, proposal: Proposal, config: ResolvedConfig): Promise<boolean> {
    return this.lock(async () => {
      const journal = await this.journal()
      const live = journal.jobs.find(j => j.id === job.id)
      if (!live || live.status !== 'running' || live.owner !== job.owner || ((journal.modes[job.personaId] ?? job.mode) === 'off' && !job.id.startsWith('tool-') && job.origin !== 'import')) return false
      const evidence = job.messages.find(m => m.messageId === proposal.messageId && m.text.includes(proposal.evidence))
      if (!evidence || proposal.intent === 'temporary' || /假设|例如|示例|引用|比如|suppose|example|quot(?:e|ing)|不要(?:再)?(?:记住|保存|记录)|do not (?:remember|save)/iu.test(evidence.text)) return false
      if (/这次|本次|this time|for this task/iu.test(evidence.text) && !/以后|今后|长期|from now on|always/iu.test(evidence.text)) return false
      if (job.origin !== 'import' && (journal.modes[job.personaId] ?? job.mode) === 'explicit' && (proposal.intent !== 'explicit' || !directIntent(evidence.text))) return false
      const project = proposal.scope === 'project' ? job.projectId : null
      if (proposal.scope === 'project' && !project) return false
      const matchingEntries = (await this.index(job.personaId)).filter(m => m.status === 'active' && m.projectId === project && (proposal.targetId ? m.id === proposal.targetId : topicKey(m.key) === topicKey(proposal.key)))
      const memories = (await Promise.all(matchingEntries.map(e => this.readEntry(e)))).filter((m): m is Memory => !!m)
      const target = proposal.targetId ? memories.find(m => m.id === proposal.targetId && m.projectId === project && m.status === 'active') : memories.find(m => topicKey(m.key) === topicKey(proposal.key) && m.projectId === project && m.status === 'active')
      if (proposal.targetId && !target) return false
      proposal = { ...proposal, key: target?.key ?? proposal.key }
      if (journal.exclusions.some(e => e.personaId === job.personaId && e.projectId === project && (e.topicHash === topicHash(proposal.key) || e.messageIds.includes(evidence.messageId)) && evidence.observedAt <= e.before)) return false
      const matching = journal.candidates.filter(c => c.personaId === job.personaId && c.projectId === project && (c.origin ?? 'learned') === (job.origin === 'import' ? 'import' : 'learned') && topicKey(c.proposal.key) === topicKey(proposal.key) && c.proposal.content === proposal.content)
      const duplicate = matching.find(c => c.status === 'pending') ?? matching.find(c => c.sources.some(s => s.messageId === evidence.messageId && s.sessionId === evidence.sessionId))
      const alreadyCounted = duplicate?.sources.some(e => e.sessionId === evidence.sessionId && e.messageId === evidence.messageId)
      if (alreadyCounted && duplicate?.status !== 'pending') return false
      const candidate: Candidate = duplicate?.status === 'pending' ? duplicate : {
        id: `c-${createHash('sha256').update(`${job.id}:${proposal.messageId}:${proposal.key}:${proposal.content}`).digest('hex').slice(0, 32)}`,
        revision: 1, personaId: job.personaId, projectId: project, proposal, sources: [], status: 'pending', reason: 'new', targetId: target?.id ?? null, baseRevision: target?.revision ?? 0, updatedAt: new Date().toISOString(), origin: job.origin === 'import' ? 'import' : 'learned',
      }
      if (!alreadyCounted) candidate.sources.push({ ...evidence, text: proposal.evidence })
      candidate.updatedAt = new Date().toISOString()
      if (candidate === duplicate) candidate.revision++
      else journal.candidates.push(candidate)
      // Persist the decision before memory I/O. On retry the learning ID reconciles a completed write.
      await this.writeJournal(journal)
      const written = await this.resolveProposal(candidate, memories, journal, config)
      await this.writeJournal(journal)
      return written
    })
  }
  /** Automatic decisions, including legacy pending receipts; no user approval queue. */
  private async resolveProposal(candidate: Candidate, memories: Memory[], journal: LearningJournal, config: ResolvedConfig): Promise<boolean> {
    const source = [...candidate.sources].sort((a, b) => b.observedAt - a.observedAt)[0]
    const target = memories.find(m => m.status === 'active' && m.projectId === candidate.projectId && topicKey(m.key) === topicKey(candidate.proposal.key))
    const excluded = !source || journal.exclusions.some(e => e.personaId === candidate.personaId && e.projectId === candidate.projectId && (e.topicHash === topicHash(candidate.proposal.key) || e.messageIds.includes(source.messageId)) && source.observedAt <= e.before)
    if (excluded || candidate.proposal.intent === 'temporary') { candidate.status = 'rejected'; candidate.reason = 'forgotten'; candidate.revision++; return false }
    if (target?.source.learningId === candidate.id) { candidate.status = 'accepted'; candidate.revision++; return false }
    const stale = !!target && (source.observedAt < (target.source.observedAt ?? Date.parse(target.updatedAt)) || source.observedAt === 0)
    const identical = target?.content === candidate.proposal.content
    candidate.reason = target?.locked ? 'locked' : stale ? 'stale' : target ? 'conflict' : candidate.proposal.intent === 'inferred' ? 'inferred' : 'new'
    const explicitOnly = candidate.origin !== 'import' && (journal.modes[candidate.personaId] ?? config.learningMode) === 'explicit' && candidate.proposal.intent !== 'explicit'
    if (identical && (stale || target.locked)) { candidate.status = 'accepted'; candidate.revision++; return false }
    if (target?.locked || stale || explicitOnly) { candidate.status = 'rejected'; candidate.revision++; return false }
    candidate.baseRevision = target?.revision ?? 0
    await this.promoteUnlocked(candidate, candidate.baseRevision, memories)
    return !identical
  }
  async settlePending(config: ResolvedConfig): Promise<void> {
    await this.lock(async () => {
      const journal = await this.journal()
      const pending = journal.candidates.filter(c => c.status === 'pending').sort((a, b) => Math.max(0, ...a.sources.map(s => s.observedAt)) - Math.max(0, ...b.sources.map(s => s.observedAt)))
      for (const candidate of pending) {
        if (candidate.origin !== 'import' && (journal.modes[candidate.personaId] ?? config.learningMode) === 'off') { candidate.status = 'rejected'; candidate.revision++ }
        else {
          const entry = (await this.index(candidate.personaId)).find(e => e.status === 'active' && e.projectId === candidate.projectId && topicKey(e.key) === topicKey(candidate.proposal.key))
          const memory = entry ? await this.readEntry(entry) : undefined
          await this.resolveProposal(candidate, memory ? [memory] : [], journal, config)
        }
        await this.writeJournal(journal)
      }
    })
  }
  private async promoteUnlocked(candidate: Candidate, expectedRevision: number, memories: Memory[]): Promise<void> {
    const current = memories.find(m => m.status === 'active' && m.projectId === candidate.projectId && topicKey(m.key) === topicKey(candidate.proposal.key))
    if (current?.source.learningId === candidate.id) { candidate.status = 'accepted'; return }
    if ((current?.revision ?? 0) !== expectedRevision) throw new Error('目标记忆已变化，请刷新后重新审阅')
    if (current?.locked) throw new Error('请先解除目标记忆的锁定')
    const source = [...candidate.sources].sort((a, b) => b.observedAt - a.observedAt)[0]!
    await this.rememberUnlocked({ personaId: candidate.personaId, projectId: candidate.projectId, key: candidate.proposal.key, content: candidate.proposal.content, category: candidate.proposal.category, pinned: current?.pinned ?? true }, expectedRevision, { kind: candidate.origin === 'import' ? 'import' : 'learned', sessionId: source.sessionId, evidence: source.text, messageIds: candidate.sources.map(s => s.messageId), learningId: candidate.id, observedAt: source.observedAt })
    candidate.status = 'accepted'; candidate.revision++
  }
  async decideCandidate(id: string, revision: number, accept: boolean, expectedRevision: number): Promise<void> {
    await this.lock(async () => {
      const journal = await this.journal()
      const candidate = journal.candidates.find(c => c.id === id && c.status === 'pending')
      if (!candidate || candidate.revision !== revision) throw new Error('候选记忆已变化，请刷新后重试')
      if (accept) await this.promoteUnlocked(candidate, expectedRevision, await this.memories(candidate.personaId))
      else {
        candidate.status = 'rejected'; candidate.revision++
        journal.exclusions.push({ personaId: candidate.personaId, projectId: candidate.projectId, topicHash: topicHash(candidate.proposal.key), before: Math.max(...candidate.sources.map(s => s.observedAt)), messageIds: candidate.sources.map(s => s.messageId) })
      }
      await this.writeJournal(journal)
    })
  }
}
