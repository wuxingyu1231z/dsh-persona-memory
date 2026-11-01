import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { snapshotSchema } from '../schema.ts'
import { managementOptionsSchema, type ManagementView } from '../management-schema.ts'
import { contribution } from '../transport.ts'
import { importReplySchema, importListSchema } from '../import-schema.ts'
import { PersonaPanel, type Api } from './PersonaPanel.tsx'
import { ManagementPage, type ManagementUi } from './ManagementPage.tsx'
import { zh, en } from './locales.ts'
import { requireMethods } from '../compatibility.ts'
export { PersonaPanel } from './PersonaPanel.tsx'
export { PersonaEditor } from './PersonaEditor.tsx'
export { ManagementPage } from './ManagementPage.tsx'

export const inject = ['slots', 'remote', 'locale', 'uiWorkspace', 'layout']
const panelId = 'persona-memory' as MainPanelId

export async function apply(ctx: Context): Promise<void> {
  requireMethods('Client', {
    'remote.$mount': ctx.remote?.$mount, 'slots.inject': ctx.slots?.inject, 'slots.register': ctx.slots?.register,
    'locale.register': ctx.locale?.register, 'locale.bind': ctx.locale?.bind,
    'uiWorkspace.openSession': ctx.uiWorkspace?.openSession, 'layout.selectPanel': ctx.layout?.selectPanel,
    'layout.panelInfo.getSnapshot': ctx.layout?.panelInfo?.getSnapshot,
  })
  await ctx.remote.$mount(contribution)
  ctx.inject(['remote.personaMemory'], registerPanels)
}

function registerPanels(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('personaMemory', { zh, en }))
  const apis = new Map<SessionId, Api>()
  const listeners = new Set<() => void>()
  let target: ManagementView = { projectId: null }
  const ui: ManagementUi = {
    target: { getSnapshot: () => target, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    setTarget: next => { target = next; for (const listener of listeners) listener() },
    manage: async (view, request) => { const result = await ctx.remote.personaMemory.manage(view, request); if (!result.ok) throw result.error; return snapshotSchema.parse(result.value) },
    options: async () => { const result = await ctx.remote.personaMemory.managementOptions(); if (!result.ok) throw result.error; return managementOptionsSchema.parse(result.value) },
    import: async (selection, request, signal) => { const result = await ctx.remote.personaMemory.importManaged(selection, request, signal); if (!result.ok) throw result.error; return importReplySchema.parse(result.value) },
    list: async () => { const result = await ctx.remote.personaMemory.listImports(); if (!result.ok) throw result.error; return importListSchema.parse(result.value) },
    openSession: id => { void ctx.uiWorkspace.openSession(id as SessionId) },
    back: () => ctx.layout.selectPanel(null),
  }
  ctx.effect(() => () => { apis.clear(); listeners.clear(); if (ctx.layout.panelInfo.getSnapshot().activePanelId === panelId) ctx.layout.selectPanel(null) })
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'persona-memory', locale: 'personaMemory', inject: () => ({ ui }) }, ManagementPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'persona-memory', order: 55, label: () => ctx.locale.bind('personaMemory')('title') }, ({ size }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="9" cy="7" r="3" /><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 13a5 5 0 0 1 3 5v2" /></svg>))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'persona-memory', order: 1000, label: () => ctx.locale.bind('personaMemory')('persona'), locale: 'personaMemory',
    inject: ownerSessionId => {
      const sessionId = ownerSessionId as SessionId
      let api = apis.get(sessionId)
      if (!api) { api = async request => { const result = await ctx.remote.personaMemory.dispatch(sessionId, request); if (!result.ok) throw result.error; return snapshotSchema.parse(result.value) }; apis.set(sessionId, api) }
      return { api, openManagement: (view: ManagementView) => { ui.setTarget(view); ctx.layout.selectPanel(panelId) } }
    },
  }, PersonaPanel))
}
