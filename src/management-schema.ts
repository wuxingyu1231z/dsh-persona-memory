import { z } from 'zod'
import { idSchema } from './schema.ts'

export const managementViewSchema = z.object({ personaId: idSchema.optional(), projectId: idSchema.nullable().default(null) }).strict()
export type ManagementView = z.infer<typeof managementViewSchema>
export const importEnvironmentSchema = z.object({ provider: z.string().max(200).default(''), model: z.string().max(300).default(''), projectId: idSchema.nullable().default(null) }).strict()
export type ImportSelection = z.infer<typeof importEnvironmentSchema>
export const managementOptionsSchema = z.object({
  providers: z.array(z.object({ id: z.string(), name: z.string() })),
  models: z.array(z.object({ provider: z.string(), id: z.string(), name: z.string() })),
  projects: z.array(z.object({ id: idSchema, label: z.string() })),
  workspaces: z.array(z.object({ id: z.string().min(1).max(200), name: z.string(), path: z.string() })).default([]),
  defaultWorkspaceId: z.string().nullable().default(null),
  defaultProvider: z.string(), defaultModel: z.string(),
})
export type ManagementOptions = z.infer<typeof managementOptionsSchema>
