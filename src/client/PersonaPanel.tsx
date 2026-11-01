import { useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Request, Snapshot } from '../schema.ts'
import type { ManagementView } from '../management-schema.ts'
import type { LocaleKey } from './locales.ts'
import { MemoryStyles, button } from './styles.tsx'
export type Api = (request: Request) => Promise<Snapshot>
export function PersonaPanel({ api, sessionId, openManagement, openView, t }: { api: Api; sessionId: SessionId; openManagement(view: ManagementView): void; openView(view: string, focus: string): void; t(key: LocaleKey): string }) {
  const [state, setState] = useState<Snapshot>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0), [reload, setReload] = useState(0)
  useEffect(() => { const current = ++generation.current; setState(undefined); setError(''); setBusy(true); void api({ op: 'snapshot' }).then(s => { if (current === generation.current) setState(s) }).catch(e => { if (current === generation.current) setError(String(e)) }).finally(() => { if (current === generation.current) setBusy(false) }); return () => { generation.current++ } }, [api, sessionId, reload])
  async function select(personaId: string) {
    if (busy || personaId === state?.selectedPersonaId) return
    const current = generation.current; setBusy(true); setError('')
    try { const next = await api({ op: 'select', personaId }); if (current === generation.current) setState(next) }
    catch (e) { if (current === generation.current) setError(String(e)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  return <section data-persona-memory data-persona-selector style={{ padding: '20px 24px', maxWidth: 1000, marginInline: 'auto', boxSizing: 'border-box' }} aria-label={t('persona')}>
    <MemoryStyles />
    <header style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <h3 style={{ margin: 0, flex: '1 1 180px' }}>{t('choosePersona')}</h3>
      <button style={button} onClick={() => openView('chat', '')}>{t('backToChat')}</button>
      <button style={button} disabled={!state} onClick={() => { if (state) openManagement({ personaId: state.selectedPersonaId, projectId: state.projectId }) }}>{t('manage')}</button>
    </header>
    <p style={{ opacity: .7, fontSize: 13 }}>{t('switchHint')}</p>
    {busy && !state && <p role="status">{t('loading')}</p>}
    <div role="group" aria-label={t('next')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 250px), 1fr))', gap: 12 }}>
      {state?.personas.map(p => <button key={p.id} type="button" data-persona-id={p.id} aria-pressed={state.selectedPersonaId === p.id} disabled={busy} onClick={() => void select(p.id)} style={{ ...button, display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start', padding: 16, textAlign: 'start', minWidth: 0, border: state.selectedPersonaId === p.id ? '2px solid var(--dsr-main, #719df5)' : '1px solid var(--border-color, #8886)' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}><strong>{p.name}</strong>{state.selectedPersonaId === p.id && <span style={{ fontSize: 12, opacity: .7 }}>{t('selectedPersona')}</span>}</div>
        <p style={{ margin: '10px 0 0', lineHeight: 1.7, opacity: .8 }}>{p.description}</p>
      </button>)}
    </div>
    {state?.activePersonaId && state.activePersonaId !== state.selectedPersonaId && <p>{t('active')}: {state.personas.find(p => p.id === state.activePersonaId)?.name}</p>}
    {state && state.verification.status !== 'not-run' && <p>{t('verification')}: {t(state.verification.status)}</p>}
    {error && <p role="alert" style={{ color: '#d55' }}>{error} <button style={button} disabled={busy} onClick={() => setReload(n => n + 1)}>{t('retry')}</button></p>}
  </section>
}
