import { z } from 'zod'
import type { InvocationDescriptor, TypertRemoteContribution, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { requestSchema, snapshotSchema, type Request, type Snapshot } from './schema.ts'
import { importRequestSchema, importReplySchema, importListSchema, type ImportRequest, type ImportReply, type ImportList } from './import-schema.ts'
import { managementViewSchema, managementOptionsSchema, importEnvironmentSchema, type ManagementView, type ManagementOptions, type ImportSelection } from './management-schema.ts'

/** One schema-defined endpoint, shared by Host validation and Client mounting. */
export const descriptor: InvocationDescriptor = {
  id: 'dsh-persona-memory#dispatch', service: 'personaMemory', namespace: 'personaMemory', method: 'dispatch',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => z.string().min(1).max(200) } },
    { name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-persona-memory#Request', create: () => requestSchema } },
  ],
  result: { mode: 'strict', typeSymbol: 'dsh-persona-memory#Snapshot', create: () => snapshotSchema },
}
export const importDescriptor: InvocationDescriptor = {
  id: 'dsh-persona-memory#importHistory', service: 'personaMemory', namespace: 'personaMemory', method: 'importHistory', invocation: { kind: 'direct' },
  parameters: [descriptor.parameters[0]!, { name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-persona-memory#ImportRequest', create: () => importRequestSchema } }],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: 'dsh-persona-memory#ImportReply', create: () => importReplySchema },
}
export const listDescriptor: InvocationDescriptor = {
  id: 'dsh-persona-memory#listImports', service: 'personaMemory', namespace: 'personaMemory', method: 'listImports', invocation: { kind: 'direct' }, parameters: [],
  result: { mode: 'strict', typeSymbol: 'dsh-persona-memory#ImportList', create: () => importListSchema },
}
export const managementDescriptor: InvocationDescriptor = {
  ...descriptor, id: 'dsh-persona-memory#manage', method: 'manage',
  parameters: [{ name: 'view', wire: 'view', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-persona-memory#ManagementView', create: () => managementViewSchema } }, descriptor.parameters[1]!],
}
export const optionsDescriptor: InvocationDescriptor = {
  ...listDescriptor, id: 'dsh-persona-memory#managementOptions', method: 'managementOptions',
  result: { mode: 'strict', typeSymbol: 'dsh-persona-memory#ManagementOptions', create: () => managementOptionsSchema },
}
export const managedImportDescriptor: InvocationDescriptor = {
  ...importDescriptor, id: 'dsh-persona-memory#importManaged', method: 'importManaged',
  parameters: [{ name: 'selection', wire: 'selection', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-persona-memory#ImportSelection', create: () => importEnvironmentSchema } }, importDescriptor.parameters[1]!],
}
export const descriptors = [descriptor, importDescriptor, listDescriptor, managementDescriptor, optionsDescriptor, managedImportDescriptor]
export const contribution: TypertRemoteContribution = { package: 'dsh-persona-memory', descriptors }
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    personaMemory: { dispatch(agentId: SessionId, request: Request): Promise<RemoteResult<Snapshot>>; importHistory(agentId: SessionId, request: ImportRequest, signal?: AbortSignal): Promise<RemoteResult<ImportReply>>; listImports(): Promise<RemoteResult<ImportList>>; manage(view: ManagementView, request: Request): Promise<RemoteResult<Snapshot>>; managementOptions(): Promise<RemoteResult<ManagementOptions>>; importManaged(selection: ImportSelection, request: ImportRequest, signal?: AbortSignal): Promise<RemoteResult<ImportReply>> }
  }
}
