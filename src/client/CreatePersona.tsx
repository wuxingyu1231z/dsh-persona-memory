import { useState } from 'react'
import type { Persona } from '../schema.ts'
import type { LocaleKey } from './locales.ts'
import { button, field, input } from './styles.tsx'

export function CreatePersona({ save, cancel, busy, t }: { save(persona: Pick<Persona, 'id' | 'name' | 'description' | 'prompt'>): Promise<void>; cancel(): void; busy: boolean; t(key: LocaleKey): string }) {
  const [error, setError] = useState('')
  return <form data-create-import-persona style={{ border: '1px solid var(--border-color, #8886)', borderRadius: 8, padding: 16, marginBlock: 12 }} onSubmit={async e => {
    e.preventDefault(); if (busy) return; setError('')
    const data = new FormData(e.currentTarget)
    try { await save({ id: String(data.get('id')), name: String(data.get('name')), description: String(data.get('description')), prompt: String(data.get('prompt')) }) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }}>
    <h3 style={{ marginTop: 0 }}>{t('create')}</h3>
    <label style={field}>{t('id')}<input style={input} name="id" defaultValue={`persona-${Date.now().toString(36)}`} pattern="[a-z0-9][a-z0-9_-]{0,79}" required maxLength={80} disabled={busy} /></label>
    <label style={field}>{t('name')}<input style={input} name="name" required maxLength={80} disabled={busy} /></label>
    <label style={field}>{t('description')}<input style={input} name="description" maxLength={1000} disabled={busy} /></label>
    <label style={field}>{t('prompt')}<textarea style={input} name="prompt" required rows={4} maxLength={16000} disabled={busy} /></label>
    {error && <p role="alert" style={{ color: '#d55' }}>{error}</p>}
    <button style={button} disabled={busy}>{t('createAndUse')}</button>{' '}<button style={button} type="button" disabled={busy} onClick={cancel}>{t('cancel')}</button>
  </form>
}
