import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Memory, Persona, Request, Snapshot } from '../schema.ts'
import type { LocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { personaMemory: LocaleKey } }
export type Api = (request: Request) => Promise<Snapshot>
interface PanelProps { api: Api; sessionId: string; t: (key: LocaleKey) => string }
const field: CSSProperties = { display: 'grid', gap: 4, marginBottom: 10 }
const input: CSSProperties = { width: '100%', padding: '7px 9px', border: '1px solid var(--border-color, #aaa6)', borderRadius: 6, background: 'Canvas', color: 'CanvasText', colorScheme: 'inherit', boxSizing: 'border-box' }
const button: CSSProperties = { padding: '5px 10px', border: '1px solid var(--border-color, #aaa6)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' }

/** Exposed for browser rendering tests; only the injected API performs I/O. */
export function PersonaEditor({ api, sessionId, t }: PanelProps) {
  const [state, setState] = useState<Snapshot>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<Persona | 'new'>()
  const [memory, setMemory] = useState<Memory | 'new'>()
  const generation = useRef(0)
  const inFlight = useRef(false)
  const requestVersion = useRef(0)
  const selected = state?.personas.find(p => p.id === state.selectedPersonaId)
  async function run(request: Request) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    const current = generation.current
    const version = ++requestVersion.current
    try { const next = await api(request); if (generation.current === current && requestVersion.current === version) { setState(next); setEditor(undefined); setMemory(undefined) } }
    catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (generation.current === current) { inFlight.current = false; setBusy(false) } }
  }
  useEffect(() => {
    generation.current++; inFlight.current = false; setState(undefined); setEditor(undefined); setMemory(undefined)
    void run({ op: 'snapshot' })
    return () => { generation.current++ }
  }, [sessionId, api])
  useEffect(() => {
    if (editor || memory) return
    const current = generation.current
    const timer = setInterval(() => {
      if (!inFlight.current) {
        const version = ++requestVersion.current
        void api({ op: 'snapshot' }).then(next => { if (generation.current === current && requestVersion.current === version && !inFlight.current) setState(next) }).catch(error => { if (generation.current === current && requestVersion.current === version) setError(error instanceof Error ? error.message : String(error)) })
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [editor, memory, api, sessionId])
  return <section data-persona-memory style={{ padding: '8px 12px', border: '1px solid var(--border-color, #aaa5)', borderRadius: 10, marginBlock: 5, fontSize: 13 }} aria-label={t('title')}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <strong>{t('title')}</strong>
      <select style={{ ...input, width: 'auto' }} aria-label={t('managePersona')} value={state?.selectedPersonaId ?? ''} disabled={busy || !state} onChange={e => void run({ op: 'select', personaId: e.target.value })}>
        {!state && <option>{t('loading')}</option>}
        {state?.personas.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button style={button} disabled={busy} onClick={() => void run({ op: 'snapshot' })}>{t('refresh')}</button>
      {state?.activePersonaId && state.activePersonaId !== state.selectedPersonaId && <span>{t('active')}: {state.personas.find(p => p.id === state.activePersonaId)?.name}</span>}
    </div>
    {error && <p role="alert" style={{ color: '#d55' }}>{error}</p>}
    {state && <div style={{ marginTop: 8 }}>
      <p><strong>{t('summary')}：</strong>{selected?.description}</p>
      <label style={field}>{t('learning')}<select style={input} aria-label={t('learning')} value={state.learningMode} disabled={busy} onChange={e => void run({ op: 'learningMode', personaId: state.selectedPersonaId, mode: e.target.value as Snapshot['learningMode'] })}>{(['off', 'explicit', 'auto'] as const).map(mode => <option key={mode} value={mode}>{t(mode)}</option>)}</select></label>
      <p style={{ opacity: .7, fontSize: 13 }}>{t('automaticMemory')}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={button} disabled={busy} onClick={() => { setEditor('new'); setMemory(undefined) }}>{t('create')}</button>
        <button style={button} disabled={busy} onClick={() => { setEditor(selected); setMemory(undefined) }}>{t('edit')}</button>
        <button style={button} disabled={busy} onClick={() => { setMemory('new'); setEditor(undefined) }}>{t('remember')}</button>
      </div>
      {editor && <form key={editor === 'new' ? 'new' : editor.id} style={{ marginTop: 12 }} onSubmit={e => {
        e.preventDefault(); const data = new FormData(e.currentTarget)
        void run({ op: 'savePersona', expectedRevision: editor === 'new' ? 0 : editor.revision, persona: { id: String(data.get('id')), name: String(data.get('name')), description: String(data.get('description')), prompt: String(data.get('prompt')) } })
      }}>
        <label style={field}>{t('id')}<input style={input} name="id" required pattern="[a-z0-9][a-z0-9_-]{0,79}" readOnly={editor !== 'new'} defaultValue={editor === 'new' ? '' : editor.id} /></label>
        <label style={field}>{t('name')}<input style={input} name="name" required maxLength={80} defaultValue={editor === 'new' ? '' : editor.name} /></label>
        <label style={field}>{t('description')}<input style={input} name="description" maxLength={1000} defaultValue={editor === 'new' ? '' : editor.description} /></label>
        <label style={field}>{t('prompt')}<textarea style={input} name="prompt" rows={5} required maxLength={16000} defaultValue={editor === 'new' ? '' : editor.prompt} /></label>
        <button style={button} disabled={busy}>{t('save')}</button> <button type="button" style={button} onClick={() => setEditor(undefined)}>{t('cancel')}</button>
      </form>}
      {memory && <form key={memory === 'new' ? 'new-memory' : memory.id} style={{ marginTop: 12 }} onSubmit={e => {
        e.preventDefault(); const data = new FormData(e.currentTarget)
        void run({ op: 'remember', expectedRevision: memory === 'new' ? 0 : memory.revision, memory: {
          personaId: state.selectedPersonaId, projectId: memory !== 'new' ? memory.projectId : data.get('scope') === 'project' ? state.projectId : null,
          key: String(data.get('key')), content: String(data.get('content')), category: data.get('category') as Memory['category'], pinned: data.get('pinned') === 'on',
        } })
      }}>
        <label style={field}>{t('key')}<input style={input} name="key" required maxLength={160} readOnly={memory !== 'new'} defaultValue={memory === 'new' ? '' : memory.key} /></label>
        <label style={field}>{t('content')}<textarea style={input} name="content" rows={3} required maxLength={6000} defaultValue={memory === 'new' ? '' : memory.content} /></label>
        <label style={field}>{t('category')}<select style={input} name="category" defaultValue={memory === 'new' ? 'preference' : memory.category}>{(['fact', 'preference', 'episode', 'procedure'] as const).map(c => <option key={c} value={c}>{t(c)}</option>)}</select></label>
        <label style={field}>{t('scope')}<select style={input} name="scope" disabled={memory !== 'new'} defaultValue={memory !== 'new' && memory.projectId ? 'project' : 'persona'}><option value="persona">{t('personaScope')}</option>{state.projectId && <option value="project">{t('projectScope')}</option>}</select></label>
        <label><input type="checkbox" name="pinned" defaultChecked={memory !== 'new' && memory.pinned} />{t('pinned')}</label><br />
        <button style={button} disabled={busy}>{t('save')}</button> <button type="button" style={button} onClick={() => setMemory(undefined)}>{t('cancel')}</button>
      </form>}
      <h4>{t('memories')} ({state.memories.length})</h4>
      {!state.memories.length && <p>{t('empty')}</p>}
      {state.memories.map(m => <article key={m.id} style={{ borderTop: '1px solid var(--border-color, #aaa5)', paddingBlock: 9 }}>
        <strong>{m.key}</strong> · {t(m.projectId ? 'projectScope' : 'personaScope')}{m.pinned ? ' ★' : ''}
        {m.locked && <span> · {t('locked')}</span>}{m.expiresAt && Date.parse(m.expiresAt) <= Date.now() && <span> · {t('expired')}</span>}
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.content}</p>
        <button style={button} disabled={busy} onClick={() => { setMemory(m); setEditor(undefined) }}>{t('editMemory')}</button>{' '}
        <button style={button} disabled={busy} onClick={() => { if (window.confirm(t('confirmForget'))) void run({ op: 'forget', personaId: m.personaId, memoryId: m.id, expectedRevision: m.revision }) }}>{t('forget')}</button>
        {' '}<button style={button} disabled={busy} onClick={() => void run({ op: 'lockMemory', personaId: m.personaId, memoryId: m.id, expectedRevision: m.revision, locked: !m.locked, expiresAt: m.expiresAt })}>{t(m.locked ? 'unlock' : 'lock')}</button>

      </article>)}
      {state.learningJobs.length > 0 && <details><summary>{t('queue')} ({state.learningJobs.length})</summary>{state.learningJobs.map(job => <p key={job.id}>{t(job.status)} {job.lastError}{job.status === 'failed' && <button style={button} disabled={busy} onClick={() => void run({ op: 'retryLearning', jobId: job.id })}>{t('retry')}</button>}</p>)}</details>}
      <details><summary>{t('stored')}</summary><code style={{ overflowWrap: 'anywhere' }}>{state.storagePath}</code></details>
    </div>}
  </section>
}
