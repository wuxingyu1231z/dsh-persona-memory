import type { CSSProperties } from 'react'
export const field: CSSProperties = { display: 'grid', gap: 6, marginBlock: 12 }
export const input: CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--border-color, #8886)', borderRadius: 7, background: 'Canvas', color: 'CanvasText', colorScheme: 'inherit', boxSizing: 'border-box' }
export const button: CSSProperties = { padding: '6px 12px', border: '1px solid var(--border-color, #8886)', borderRadius: 7, background: 'transparent', color: 'inherit', cursor: 'pointer' }
// Native Windows popups need a matched system color pair, following DSH's color-scheme.
export function MemoryStyles() {
  return <style>{`[data-persona-memory] select, [data-persona-memory] option, [data-persona-import] select, [data-persona-import] option { color-scheme: inherit; background-color: Canvas; color: CanvasText; }
    [data-persona-memory] button:focus-visible, [data-persona-memory] select:focus-visible, [data-persona-memory] input:focus-visible, [data-persona-memory] textarea:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
    [data-persona-memory] button:disabled { opacity: .5; cursor: default; }
    [data-persona-memory] p { overflow-wrap: anywhere; }
    @media(max-width:640px) { [data-persona-memory-page] { padding: 16px !important; padding-top: max(16px, var(--dsh-frame-top-clearance, 0px)) !important; } }
  `}</style>
}
