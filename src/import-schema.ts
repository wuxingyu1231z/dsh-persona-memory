import { z } from 'zod'
import { idSchema, personaInputSchema, proposalSchema } from './schema.ts'

export const historyMessageSchema = z.object({ id: z.string().min(1).max(300), role: z.enum(['user', 'assistant']), text: z.string().max(2000000), at: z.number().nonnegative().nullable(), clipped: z.boolean().optional() })
export type HistoryMessage = z.infer<typeof historyMessageSchema>
export const draftSchema = z.object({ name: z.string().min(1).max(80), description: z.string().max(1000), prompt: z.string().min(1).max(2000) }).strict()
export const analysisSchema = z.object({ summary: z.string().min(1).max(8000), personaDraft: draftSchema, topic: z.enum(['research', 'coding', 'daily', 'other']), proposals: z.array(proposalSchema).max(100) }).strict()
export type ImportAnalysis = z.infer<typeof analysisSchema>
export const conversationSchema = z.object({
  id: idSchema, sourceId: z.string().max(300), branchId: z.string().max(300), platform: z.enum(['deepseek', 'chatgpt', 'generic', 'markdown']),
  title: z.string().max(300), preferred: z.boolean(), messages: z.array(historyMessageSchema).min(1), warnings: z.array(z.string()),
  parts: z.array(z.object({ hash: z.string(), analysis: analysisSchema })).default([]), analysis: analysisSchema.nullable().default(null), analysisKey: z.string().default(''),
})
export type ImportedConversation = z.infer<typeof conversationSchema>
export const batchSchema = z.object({ version: z.literal(1), id: idSchema, filename: z.string().max(200), fingerprint: z.string(), createdAt: z.string(), conversations: z.array(conversationSchema).min(1), warnings: z.array(z.string()), applied: z.array(z.string()).default([]) })
export type ImportBatch = z.infer<typeof batchSchema>
export const uploadSchema = z.object({ version: z.literal(1), id: idSchema, filename: z.string(), total: z.number().int().positive().max(1024), expected: z.number().int().positive().max(10000), createdAt: z.string(), complete: idSchema.nullable(), parts: z.array(z.object({ index: z.number().int().nonnegative(), fingerprint: z.string(), id: idSchema, characters: z.number().int().nonnegative() })) })
export type ImportUpload = z.infer<typeof uploadSchema>
export const importRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('preview'), filename: z.string().min(1).max(200), text: z.string().max(4000000), format: z.enum(['auto', 'json', 'markdown']) }).strict(),
  z.object({ op: z.literal('open'), batchId: idSchema, conversationId: idSchema.optional(), offset: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ op: z.literal('analyze'), batchId: idSchema, conversationIds: z.array(idSchema).min(1).max(32) }).strict(),
  z.object({ op: z.literal('apply'), batchId: idSchema, conversationIds: z.array(idSchema).min(1).max(32), personaId: idSchema, newPersona: personaInputSchema.optional() }).strict(),
  z.object({ op: z.literal('continue'), batchId: idSchema, conversationId: idSchema, personaId: idSchema, mode: z.enum(['summary', 'full']), requestId: idSchema, workspaceId: z.string().min(1).max(200).nullable().optional() }).strict(),
  z.object({ op: z.literal('beginUpload'), filename: z.string().min(1).max(200), requestId: idSchema, parts: z.number().int().min(1).max(1024), branches: z.number().int().min(1).max(10000) }).strict(),
  z.object({ op: z.literal('uploadPart'), uploadId: idSchema, index: z.number().int().min(0).max(1023), text: z.string().max(4000000), format: z.enum(['json', 'markdown']) }).strict(),
  z.object({ op: z.literal('finishUpload'), uploadId: idSchema }).strict(),
])
export type ImportRequest = z.infer<typeof importRequestSchema>
export const importReplySchema = z.object({
  batchId: idSchema, filename: z.string(), warnings: z.array(z.string()),
  conversations: z.array(conversationSchema.omit({ messages: true, parts: true, analysisKey: true }).extend({ messageCount: z.number(), estimatedCalls: z.number(), analysisReady: z.boolean().default(false) })),
  page: z.object({ conversationId: idSchema, offset: z.number(), total: z.number(), messages: z.array(historyMessageSchema) }).nullable(),
  continuedSessionId: z.string().nullable(), stagedCandidates: z.number(), savedMemories: z.number().int().nonnegative().default(0),
})
export type ImportReply = z.infer<typeof importReplySchema>
export const importListSchema = z.array(z.object({ id: idSchema, filename: z.string(), createdAt: z.string(), conversations: z.number() }))
export type ImportList = z.infer<typeof importListSchema>
