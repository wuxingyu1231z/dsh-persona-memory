import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Persona } from '../schema.ts'
import type { ImportRequest, ImportReply, ImportList } from '../import-schema.ts'
import type { LocaleKey } from './locales.ts'
import { preprocessHistory, historyParts } from '../preprocess.ts'
import { uploadChunks } from '../import-upload.ts'
import type { ManagementOptions } from '../management-schema.ts'

export interface ImportUi {
  request(request: ImportRequest, signal: AbortSignal): Promise<ImportReply>
  list(): Promise<ImportList>
  openSession(id: string): void
}
interface Props { api: ImportUi; personas: Persona[]; selectedPersonaId: string; applied(id: string): Promise<void>; t(key: LocaleKey): string; onBusyChange?(busy: boolean): void; contextKey?: string; workspaces?: ManagementOptions['workspaces']; defaultWorkspaceId?: string | null; workspacesReady?: boolean }
const field: CSSProperties = { display: 'grid', gap: 4, marginBlock: 10 }
const input: CSSProperties = { width: '100%', padding: 7, border: '1px solid var(--border-color, #aaa6)', borderRadius: 6, background: 'Canvas', color: 'CanvasText', colorScheme: 'inherit', boxSizing: 'border-box' }
const button: CSSProperties = { padding: '5px 10px', border: '1px solid var(--border-color, #aaa6)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' }

export function ImportPanel({ api, personas, selectedPersonaId, applied, t, onBusyChange, contextKey = '', workspaces = [], defaultWorkspaceId = null, workspacesReady = true }: Props) {
  const [archives, setArchives] = useState<ImportList>([])
  const [reply, setReply] = useState<ImportReply>()
  const [selected, setSelected] = useState<string[]>([])
  const [target, setTarget] = useState(selectedPersonaId)
  const [mode, setMode] = useState<'summary' | 'full'>('summary')
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const workspaceInitialized = useRef(false)
  const workspace = workspaces.find(w => w.id === workspaceId)
  const workspaceMissing = workspaceId !== null && !workspace
  const [draft, setDraft] = useState({ id: '', name: '', description: '', prompt: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [progress, setProgress] = useState('')
  const [statistics, setStatistics] = useState<{ raw: number; clean: number; conversations: number; removed: number }>()
  const uploadJob = useRef<{ filename: string; requestId: string; parts: ReturnType<typeof historyParts>; branches: number; sources: number }>()
  const controller = useRef<AbortController>()
  const alive = useRef(true)
  const draftKey = useRef('')
  const continuation = useRef({ key: '', requestId: '' })
  const current = reply?.conversations.find(c => c.id === reply.page?.conversationId)
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  useEffect(() => () => { onBusyChange?.(false) }, [onBusyChange])
  useEffect(() => { setTarget(selectedPersonaId) }, [selectedPersonaId])
  useEffect(() => {
    if (workspacesReady && !workspaceInitialized.current) {
      workspaceInitialized.current = true; setWorkspaceId(defaultWorkspaceId)
    }
  }, [workspacesReady, defaultWorkspaceId])
  useEffect(() => {
    alive.current = true
    void api.list().then(value => { if (alive.current) setArchives(value) }).catch(e => { if (alive.current) setError(String(e)) })
    return () => { alive.current = false; controller.current?.abort() }
  }, [api])
  useEffect(() => {
    if (!current?.analysis || draftKey.current === current.id) return
    draftKey.current = current.id
    setDraft({ id: `import-${Date.now().toString(36)}`, ...current.analysis.personaDraft })
  }, [current])
  async function run(request: ImportRequest) {
    if (controller.current) return
    const abort = new AbortController(); controller.current = abort; setBusy(true); setError(''); setNotice('')
    try {
      let value: ImportReply
      if (request.op === 'analyze') {
        let pending = request.conversationIds, step = 0
        do {
          abort.signal.throwIfAborted()
          setProgress(`${t('analysisProgress')} ${++step} · ${t('remainingBranches')} ${pending.length}`)
          value = await api.request({ ...request, conversationIds: pending, incremental: true }, abort.signal)
          if (alive.current) setReply(value)
          pending = value.pendingAnalysisIds ?? []
        } while (pending.length)
      } else value = await api.request(request, abort.signal)
      if (!alive.current) return
      setReply(value)
      if (request.op === 'open' && !request.conversationId || request.op === 'preview') {
        setSelected(value.page ? [value.page.conversationId] : []); draftKey.current = ''
        setArchives(await api.list())
      }
      if (request.op === 'apply') {
        setTarget(request.personaId); setNotice(`${t('savedMemories')}: ${value.savedMemories}`)
        await applied(request.personaId)
      }
      if (value.continuedSessionId) {
        api.openSession(value.continuedSessionId)
        continuation.current = { key: '', requestId: '' }
      }
    } catch (e) { if (alive.current) setError(abort.signal.aborted ? t('importCancelled') : e instanceof Error ? e.message : String(e)) }
    finally { if (controller.current === abort) controller.current = undefined; if (alive.current) { setBusy(false); setProgress('') } }
  }
  async function upload(file?: { name: string; size: number; text(): Promise<string> }) {
    if (controller.current) return
    const abort = new AbortController(); controller.current = abort; setBusy(true); setError(''); setNotice(''); setProgress(t('preprocessing'))
    let stage = t('preprocessing')
    // Only retry transport failures. The Host receipts make these requests idempotent.
    const send = async (request: ImportRequest): Promise<ImportReply> => {
      for (let attempt = 0; ; attempt++) {
        try { return await api.request(request, abort.signal) }
        catch (error) {
          abort.signal.throwIfAborted()
          if (attempt >= 2 || !/failed to fetch|network|connection|transport failure/i.test(String(error))) throw error
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
          abort.signal.throwIfAborted()
        }
      }
    }
    try {
      if (file) {
        uploadJob.current = undefined
        if (file.size > 64000000) throw new Error(t('rawTooLarge'))
        const text = await file.text(); abort.signal.throwIfAborted()
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        const prepared = preprocessHistory(file.name, text), parts = historyParts(prepared)
        uploadJob.current = { filename: file.name.slice(0, 200), requestId: `upload-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)}`, parts, branches: prepared.conversations.reduce((n, c) => n + c.branches, 0), sources: prepared.conversations.length }
        setStatistics({ raw: file.size, clean: prepared.preparedCharacters, conversations: prepared.conversations.length, removed: prepared.removedFragments })
      }
      const job = uploadJob.current; if (!job) return
      let value: ImportReply
      {
        stage = t('preparingUpload')
        const started = await send({ op: 'beginUpload', filename: job.filename, requestId: job.requestId, parts: job.parts.length, branches: job.branches })
        if (started.conversations.length) value = started
        else {
          for (let index = 0; index < job.parts.length; index++) {
            const part = job.parts[index], chunks = uploadChunks(part.text)
            for (const [chunk, text] of chunks.entries()) {
              abort.signal.throwIfAborted()
              stage = `${t('uploadingAll')} ${index + 1}/${job.parts.length} · ${chunk + 1}/${chunks.length}`
              if (alive.current) setProgress(stage)
              await send({ op: 'uploadChunk', uploadId: started.batchId, index, chunk, total: chunks.length, text, format: part.format })
            }
          }
          stage = t('committingUpload')
          if (alive.current) setProgress(stage)
          value = await send({ op: 'finishUpload', uploadId: started.batchId })
        }
      }
      if (!alive.current) return
      setReply(value); setSelected(value.page ? [value.page.conversationId] : []); draftKey.current = ''
      setNotice(`${t('importedAll')}: ${job.sources} · ${t('branchCount')}: ${value.conversations.length}`)
      uploadJob.current = undefined; setArchives(await api.list())
    } catch (e) { if (alive.current) setError(abort.signal.aborted ? t('importCancelled') : `${stage}: ${e instanceof Error ? e.message : String(e)}`) }
    finally { if (controller.current === abort) controller.current = undefined; if (alive.current) { setBusy(false); setProgress('') } }
  }
  return <section data-persona-import style={{ marginTop: 15, borderTop: '1px solid var(--border-color, #aaa5)', paddingTop: 10 }}>
    <p>{t('importHint')}</p>
    <label style={field}>{t('importFile')}<input aria-label={t('importFile')} type="file" accept=".json,.md,.markdown" disabled={busy} onChange={e => {
      const file = e.target.files?.[0]; if (!file) return
      void upload(file); e.target.value = ''
    }} /></label>
    {statistics && <p data-import-statistics style={{ opacity: .8 }}>{t('preprocessed')}: {statistics.conversations} · {(statistics.raw / 1000000).toFixed(2)} MB → {statistics.clean.toLocaleString()} {t('characters')} · {t('removedFragments')}: {statistics.removed}</p>}
    {!busy && uploadJob.current && <button style={button} onClick={() => void upload()}>{t('retryImport')}</button>}
    <label style={field}>{t('archives')}<select style={input} aria-label={t('archives')} disabled={busy} value={reply?.batchId ?? ''} onChange={e => { if (e.target.value) void run({ op: 'open', batchId: e.target.value, offset: 0 }) }}>
      <option value="">{t('chooseArchive')}</option>{archives.map(a => <option key={a.id} value={a.id}>{a.filename} ({a.conversations})</option>)}
    </select></label>
    {error && <p role="alert" style={{ color: '#d55' }}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">{progress || t('importWorking')} <button style={button} onClick={() => controller.current?.abort()}>{t('cancel')}</button></p>}
    {reply && <>
      <details><summary>{t('importWarnings')} ({reply.warnings.length})</summary>{reply.warnings.map((w, i) => <p key={i}>{w}</p>)}</details>
      <label style={field}>{t('branch')}<select style={input} aria-label={t('branch')} value={current?.id ?? ''} disabled={busy} onChange={e => { draftKey.current = ''; void run({ op: 'open', batchId: reply.batchId, conversationId: e.target.value, offset: 0 }) }}>
        {reply.conversations.map(c => <option key={c.id} value={c.id}>{c.title} · {c.platform} · {c.branchId}{c.preferred ? ` · ${t('preferredBranch')}` : ''}</option>)}
      </select></label>
      <details><summary>{t('bulkSelection')} ({selected.length})</summary>{reply.conversations.map(c => <label key={c.id} style={{ display: 'block', marginBlock: 6 }}><input type="checkbox" disabled={busy || selected.length >= 32 && !selected.includes(c.id)} checked={selected.includes(c.id)} onChange={e => setSelected(e.target.checked ? [...selected, c.id] : selected.filter(id => id !== c.id))} />{c.title} · {c.branchId} ({c.messageCount})</label>)}</details>
      {current && <>
        <p>{t('analysisCost')}: {current.estimatedCalls} · {t('messageCount')}: {current.messageCount}</p>
        <button style={button} disabled={busy} onClick={() => void run({ op: 'analyze', batchId: reply.batchId, conversationIds: [current.id] })}>{t('extractCurrent')}</button>{' '}
        <button style={button} disabled={busy || !selected.length} onClick={() => void run({ op: 'analyze', batchId: reply.batchId, conversationIds: selected })}>{t('extractSelected')}</button>
        <details style={{ marginTop: 10 }}><summary>{t('originalPreview')}</summary>
          {reply.page?.messages.map(m => <article key={m.id} style={{ borderTop: '1px solid var(--border-color, #aaa5)', paddingBlock: 8 }}><strong>{t(m.role === 'user' ? 'historyUser' : 'historyAssistant')}</strong> · {m.at === null ? t('unknownDate') : new Date(m.at).toLocaleString()}<pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit' }}>{m.text}</pre>{m.clipped && <span>{t('previewClipped')}</span>}</article>)}
          <button style={button} disabled={busy || !reply.page || reply.page.offset === 0} onClick={() => void run({ op: 'open', batchId: reply.batchId, conversationId: current.id, offset: Math.max(0, reply.page!.offset - 50) })}>{t('prevPage')}</button>{' '}
          <button style={button} disabled={busy || !reply.page || reply.page.offset + 50 >= reply.page.total} onClick={() => void run({ op: 'open', batchId: reply.batchId, conversationId: current.id, offset: reply.page!.offset + 50 })}>{t('nextPage')}</button>
        </details>
        {current.analysis && <>
          <h4>{t('handoffSummary')} · {current.analysis.topic}</h4><p style={{ whiteSpace: 'pre-wrap' }}>{current.analysis.summary}</p>
          <details><summary>{t('extractedPreferences')} ({current.analysis.proposals.length})</summary>{current.analysis.proposals.map((p, i) => <article key={i}><strong>{p.key}</strong><p>{p.content}</p><blockquote style={{ whiteSpace: 'pre-wrap' }}>{p.evidence}</blockquote></article>)}</details>
          <label style={field}>{t('importTarget')}<select style={input} aria-label={t('importTarget')} disabled={busy} value={target} onChange={e => setTarget(e.target.value)}><option value="__new">{t('createFromHistory')}</option>{personas.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          {target === '__new' && <div>{(['id', 'name', 'description', 'prompt'] as const).map(key => <label key={key} style={field}>{t(key)}{key === 'prompt' ? <textarea rows={5} style={input} aria-label={t('draftPrompt')} value={draft[key]} maxLength={2000} onChange={e => setDraft({ ...draft, [key]: e.target.value })} /> : <input style={input} aria-label={`import-${key}`} value={draft[key]} maxLength={key === 'description' ? 1000 : 80} onChange={e => setDraft({ ...draft, [key]: e.target.value })} />}</label>)}</div>}
          <p>{t('applyHint')}</p>
          <button style={button} disabled={busy} onClick={() => void run({ op: 'apply', batchId: reply.batchId, conversationIds: [current.id], personaId: target === '__new' ? draft.id : target, ...(target === '__new' ? { newPersona: draft } : {}) })}>{t('applyCurrent')}</button>{' '}
          <button style={button} disabled={busy || !selected.length || selected.some(id => { const c = reply.conversations.find(c => c.id === id); return !c?.analysisReady && !c?.analysis })} onClick={() => void run({ op: 'apply', batchId: reply.batchId, conversationIds: selected, personaId: target === '__new' ? draft.id : target, ...(target === '__new' ? { newPersona: draft } : {}) })}>{t('applySelected')}</button>
          <label style={field}>{t('continuationMode')}<select style={input} aria-label={t('continuationMode')} disabled={busy} value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="summary">{t('summaryMode')}</option><option value="full">{t('fullMode')}</option></select></label>
          <p>{t('continuationHint')}</p>
          <label style={field}>{t('continuationWorkspace')}<select style={input} aria-label={t('continuationWorkspace')} value={workspaceId ?? ''} disabled={busy || !workspacesReady} onChange={e => setWorkspaceId(e.target.value || null)}>
            <option value="">{t('ungroupedWorkspace')}</option>
            {workspaceMissing && <option value={workspaceId!} disabled>{t('workspaceUnavailable')}</option>}
            {workspaces.map(w => <option key={w.id} value={w.id}>{w.name === 'default-workspace' ? t('defaultWorkspace') : w.name} · {w.path}</option>)}
          </select></label>
          <p style={{ opacity: .7, overflowWrap: 'anywhere' }}>{t('continuationWorkspaceHint')} {workspace ? `${t('continuationDirectory')}: ${workspace.path}` : workspaceMissing ? t('workspaceUnavailable') : t('ungroupedWorkspaceHint')}</p>
          <div><button style={button} disabled={busy || target === '__new' || !workspacesReady || workspaceMissing} onClick={() => {
            const key = `${contextKey}:${reply.batchId}:${current.id}:${target}:${mode}:${workspaceId ?? 'ungrouped'}`
            if (continuation.current.key !== key) continuation.current = { key, requestId: `open-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)}` }
            void run({ op: 'continue', batchId: reply.batchId, conversationId: current.id, personaId: target, mode, workspaceId, requestId: continuation.current.requestId })
          }}>{t('continueHistory')}</button></div>
        </>}
      </>}
    </>}
  </section>
}
