import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Request, Snapshot } from '../schema.ts'
import type { ImportList, ImportReply, ImportRequest } from '../import-schema.ts'
import type { ManagementView, ManagementOptions, ImportSelection } from '../management-schema.ts'
import { PersonaEditor } from './PersonaEditor.tsx'
import { ImportPanel, type ImportUi } from './ImportPanel.tsx'
import { MemoryStyles, button, field, input } from './styles.tsx'
import type { LocaleKey } from './locales.ts'
import { CreatePersona } from './CreatePersona.tsx'

export interface ManagementUi {
  target: { getSnapshot(): ManagementView; subscribe(listener: () => void): () => void }
  setTarget(view: ManagementView): void
  manage(view: ManagementView, request: Request): Promise<Snapshot>
  options(): Promise<ManagementOptions>
  import(selection: ImportSelection, request: ImportRequest, signal: AbortSignal): Promise<ImportReply>
  list(): Promise<ImportList>
  openSession(id: string): void
  back(): void
}

export function ManagementPage({ ui, t }: { ui: ManagementUi; t(key: LocaleKey): string }) {
  const view = useSyncExternalStore(ui.target.subscribe, ui.target.getSnapshot)
  const [tab, setTab] = useState<'personas' | 'history'>('personas')
  const [snapshot, setSnapshot] = useState<Snapshot>(), [options, setOptions] = useState<ManagementOptions>()
  const [provider, setProvider] = useState(''), [model, setModel] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [creating, setCreating] = useState(false), [savingPersona, setSavingPersona] = useState(false)
  const pageBusy = busy || savingPersona
  const selection = useRef<ImportSelection>({ provider: '', model: '', projectId: null })
  const currentView = useRef(view); currentView.current = view
  selection.current = { provider, model, projectId: view.projectId }
  const api = useMemo(() => async (request: Request) => {
    const value = await ui.manage(view, request)
    if (currentView.current === view) {
      setSnapshot(value)
      if (request.op === 'select') ui.setTarget({ ...view, personaId: value.selectedPersonaId })
    }
    return value
  }, [ui, view])
  const imports: ImportUi = useMemo(() => ({ request: (request, signal) => ui.import({ ...selection.current }, request, signal), list: () => ui.list(), openSession: id => ui.openSession(id) }), [ui])
  useEffect(() => {
    let alive = true
    void ui.options().then(value => { if (alive) { setOptions(value); setProvider(value.defaultProvider); setModel(value.defaultModel) } }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [ui])
  useEffect(() => { let alive = true; setError(''); void ui.manage(view, { op: 'snapshot' }).then(value => { if (alive) setSnapshot(value) }).catch(e => { if (alive) setError(String(e)) }); return () => { alive = false } }, [ui, view])
  return <main data-persona-memory data-persona-memory-page style={{ height: '100%', boxSizing: 'border-box', overflowY: 'auto', padding: 'max(28px, var(--dsh-frame-top-clearance, 0px)) 28px 32px', paddingInlineStart: 'max(28px, var(--dsh-frame-leading-clearance, 0px))' }}>
    <MemoryStyles />
    <div style={{ maxWidth: 960, marginInline: 'auto' }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}><div style={{ minWidth: 0, flex: '1 1 260px' }}><h2 style={{ marginBottom: 6 }}>{t('title')}</h2><p style={{ opacity: .7 }}>{t('managementHint')}</p></div><button style={{ ...button, whiteSpace: 'nowrap' }} onClick={ui.back}>{t('backToChat')}</button></header>
      <nav aria-label={t('managementTabs')} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderBottom: '1px solid var(--border-color, #8885)', paddingBottom: 14 }}>
        {(['personas', 'history'] as const).map(id => <button key={id} style={{ ...button, fontWeight: tab === id ? 700 : 400, borderColor: tab === id ? 'currentColor' : undefined }} disabled={pageBusy} aria-pressed={tab === id} onClick={() => setTab(id)}>{t(id === 'personas' ? 'personaSettings' : 'historyImport')}</button>)}
      </nav>
      <label style={field}>{t('managementScope')}<select style={input} aria-label={t('managementScope')} value={view.projectId ?? ''} disabled={pageBusy} onChange={e => ui.setTarget({ ...view, projectId: e.target.value || null })}>
        <option value="">{t('personaScope')}</option>{view.projectId && !options?.projects.some(p => p.id === view.projectId) && <option value={view.projectId}>{view.projectId}</option>}{options?.projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select></label>
      <p style={{ opacity: .7, fontSize: 13 }}>{t('scopeHint')}</p>
      {error && <p role="alert" style={{ color: '#d55' }}>{error}</p>}
      {tab === 'personas' && <PersonaEditor api={api} sessionId={`${view.personaId ?? ''}:${view.projectId ?? ''}`} t={t} />}
      {tab === 'history' && <section aria-label={t('historyImport')}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
          <label style={{ ...field, flex: '1 1 240px' }}>{t('managePersona')}<select style={input} aria-label={t('managePersona')} disabled={pageBusy || !snapshot} value={snapshot?.selectedPersonaId ?? ''} onChange={e => { ui.setTarget({ ...view, personaId: e.target.value }) }}>{snapshot?.personas.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <button style={{ ...button, marginBottom: 12 }} disabled={pageBusy} onClick={() => setCreating(!creating)}>{t('create')}</button>
        </div>
        {creating && <CreatePersona busy={pageBusy} t={t} cancel={() => setCreating(false)} save={async persona => {
          setSavingPersona(true)
          try { await api({ op: 'savePersona', persona, expectedRevision: 0 }); await api({ op: 'select', personaId: persona.id }); setCreating(false) } finally { setSavingPersona(false) }
        }} />}
        <fieldset disabled={savingPersona} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <label style={{ ...field, flex: '1 1 200px' }}>{t('importProvider')}<select style={input} aria-label={t('importProvider')} value={provider} disabled={busy} onChange={e => { setProvider(e.target.value); setModel(options?.models.find(m => m.provider === e.target.value)?.id ?? '') }}><option value="">{t('chooseProvider')}</option>{options?.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label style={{ ...field, flex: '1 1 240px' }}>{t('importModel')}<input style={input} aria-label={t('importModel')} list="persona-memory-models" value={model} disabled={busy} onChange={e => setModel(e.target.value)} /><datalist id="persona-memory-models">{options?.models.filter(m => m.provider === provider).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist></label>
        </div>
        <p style={{ opacity: .7 }}>{t('importModelHint')}</p>
        {snapshot && <ImportPanel api={imports} personas={snapshot.personas} selectedPersonaId={snapshot.selectedPersonaId} applied={async id => { await api({ op: 'select', personaId: id }) }} t={t} onBusyChange={setBusy} contextKey={`${provider}:${model}`} workspaces={options?.workspaces ?? []} defaultWorkspaceId={options?.defaultWorkspaceId ?? null} workspacesReady={!!options} />}
        </fieldset>
      </section>}
    </div>
  </main>
}
