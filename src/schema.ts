import { z } from 'zod'

export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/)
export const personaInputSchema = z.object({
  id: idSchema, name: z.string().trim().min(1).max(80),
  description: z.string().max(1000), prompt: z.string().trim().min(1).max(16000),
}).strict()
export const personaSchema = personaInputSchema.extend({ revision: z.number().int().positive(), updatedAt: z.string() })
export type Persona = z.infer<typeof personaSchema>
export const memoryInputSchema = z.object({
  personaId: idSchema, projectId: idSchema.nullable(),
  key: z.string().trim().min(1).max(160), content: z.string().trim().min(1).max(6000),
  category: z.enum(['fact', 'preference', 'episode', 'procedure']), pinned: z.boolean(),
}).strict()
export const memorySchema = memoryInputSchema.extend({
  locked: z.boolean().default(false), expiresAt: z.string().datetime().nullable().default(null),
  id: idSchema, revision: z.number().int().positive(), status: z.enum(['active', 'superseded', 'forgotten']),
  source: z.object({ kind: z.enum(['user', 'import', 'learned']), sessionId: z.string().max(200).optional(), evidence: z.string().max(6000).optional(), messageIds: z.array(z.string()).optional(), learningId: z.string().optional(), observedAt: z.number().optional() }).strict(),
  createdAt: z.string(), updatedAt: z.string(),
})
export type Memory = z.infer<typeof memorySchema>
export const learningModeSchema = z.enum(['off', 'explicit', 'auto'])
export const evidenceSchema = z.object({ messageId: z.string(), sessionId: z.string(), text: z.string().max(12000), observedAt: z.number() }).strict()
export const proposalSchema = z.object({
  key: z.string().trim().min(1).max(160), content: z.string().trim().min(1).max(6000),
  category: z.enum(['fact', 'preference', 'episode', 'procedure']), scope: z.enum(['persona', 'project']),
  intent: z.enum(['explicit', 'inferred', 'temporary']), evidence: z.string().min(1).max(2000), messageId: z.string(),
  targetId: idSchema.nullable(),
}).strict()
export type Proposal = z.infer<typeof proposalSchema>
export const candidateSchema = z.object({
  origin: z.enum(['import', 'learned']).optional(),
  id: idSchema, revision: z.number().int().positive(), personaId: idSchema, projectId: idSchema.nullable(),
  proposal: proposalSchema, sources: z.array(evidenceSchema), status: z.enum(['pending', 'accepted', 'rejected']),
  reason: z.enum(['new', 'inferred', 'conflict', 'locked', 'stale', 'forgotten']),
  targetId: idSchema.nullable(), baseRevision: z.number().int().nonnegative(), updatedAt: z.string(),
})
export type Candidate = z.infer<typeof candidateSchema>
export const jobSchema = z.object({
  origin: z.enum(['import', 'chat']).optional(),
  id: idSchema, personaId: idSchema, projectId: idSchema.nullable(), sessionId: z.string(),
  messages: z.array(evidenceSchema), provider: z.string(), model: z.string(),
  mode: learningModeSchema, status: z.enum(['pending', 'running', 'complete', 'failed']),
  attempts: z.number().int().nonnegative(), owner: z.string().nullable(), leaseUntil: z.number(),
  nextAttemptAt: z.number(), lastError: z.string().nullable(), createdAt: z.number(),
})
export type LearningJob = z.infer<typeof jobSchema>
export const journalSchema = z.object({
  version: z.literal(1), modes: z.record(z.string(), learningModeSchema),
  jobs: z.array(jobSchema), candidates: z.array(candidateSchema),
  exclusions: z.array(z.object({ personaId: idSchema, projectId: idSchema.nullable(), topicHash: z.string(), before: z.number(), messageIds: z.array(z.string()).default([]) })),
  cursors: z.record(z.string(), z.number().int().nonnegative()).default({}),
})
export type LearningJournal = z.infer<typeof journalSchema>
export const verificationSchema = z.object({ status: z.enum(['passed', 'failed', 'not-run', 'blocked']), checks: z.array(z.object({ id: z.string(), status: z.enum(['passed', 'failed', 'blocked']), detail: z.string() })), at: z.string().nullable() })
export type Verification = z.infer<typeof verificationSchema>
export const requestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('snapshot') }).strict(),
  z.object({ op: z.literal('select'), personaId: idSchema }).strict(),
  z.object({ op: z.literal('savePersona'), persona: personaInputSchema, expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ op: z.literal('remember'), memory: memoryInputSchema, expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ op: z.literal('forget'), personaId: idSchema, memoryId: idSchema, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ op: z.literal('learningMode'), personaId: idSchema, mode: learningModeSchema }).strict(),
  z.object({ op: z.literal('candidate'), candidateId: idSchema, revision: z.number().int().positive(), accept: z.boolean(), expectedMemoryRevision: z.number().int().nonnegative() }).strict(),
  z.object({ op: z.literal('lockMemory'), personaId: idSchema, memoryId: idSchema, expectedRevision: z.number().int().positive(), locked: z.boolean(), expiresAt: z.string().datetime().nullable() }).strict(),
  z.object({ op: z.literal('retryLearning'), jobId: idSchema }).strict(),
])
export type Request = z.infer<typeof requestSchema>
export const snapshotSchema = z.object({
  personas: z.array(personaSchema), memories: z.array(memorySchema),
  selectedPersonaId: idSchema, activePersonaId: idSchema.nullable(), projectId: idSchema.nullable(),
  storagePath: z.string(), phase: z.literal(3),
  learningMode: learningModeSchema, candidates: z.array(candidateSchema),
  learningJobs: z.array(jobSchema.omit({ messages: true, owner: true })), verification: verificationSchema,
})
export type Snapshot = z.infer<typeof snapshotSchema>
export interface Config {
  memoryDir?: string; defaultPersona?: string; maxContextChars?: number; recallLimit?: number; lockWaitMs?: number; lockStaleMs?: number
  learningMode?: 'off' | 'explicit' | 'auto'; learningTimeoutMs?: number; learningPollMs?: number; learningMaxAttempts?: number
  learningInputChars?: number; learningOutputChars?: number; learningMaxTokens?: number
  importMaxTokens?: number; importTimeoutMs?: number
  /** Accepted for old configurations; automatic decisions no longer use an evidence-count threshold. */
  inferredEvidenceCount?: number
  verificationChecks?: { id: string; label: string; tool: string; arguments: Record<string, unknown>; exitCodeField?: string; projectId?: string | null }[]
  importMaxChars?: number; importMaxConversations?: number; importMaxBranches?: number; importMaxMessages?: number; importInputChars?: number; importSummaryChars?: number; importMaxChunks?: number; continuationChars?: number
  embedding?: { provider: 'ollama' | 'openai-compatible'; endpoint: string; model: string; apiKeyEnv?: string; timeoutMs?: number; minSimilarity?: number; batchSize?: number }
}
export const configSchema = z.object({
  memoryDir: z.string().min(1).optional(), defaultPersona: idSchema.default('research-mentor'),
  maxContextChars: z.number().int().min(2000).max(32000).default(12000),
  recallLimit: z.number().int().min(1).max(40).default(8), lockWaitMs: z.number().int().min(100).max(30000).default(5000),
  lockStaleMs: z.number().int().min(6000).max(300000).default(30000),
  learningMode: learningModeSchema.default('auto'), learningTimeoutMs: z.number().int().min(1000).max(300000).default(60000),
  learningPollMs: z.number().int().min(100).max(30000).default(2000), learningMaxAttempts: z.number().int().min(1).max(10).default(3),
  learningInputChars: z.number().int().min(2000).max(64000).default(16000), learningOutputChars: z.number().int().min(2000).max(64000).default(16000),
  learningMaxTokens: z.number().int().min(256).max(8192).default(2048), inferredEvidenceCount: z.number().int().min(2).max(10).default(3),
  verificationChecks: z.array(z.object({ id: idSchema, label: z.string().min(1).max(100), tool: z.string().min(1), arguments: z.record(z.string(), z.json()), exitCodeField: z.string().default('exitCode'), projectId: idSchema.nullable().default(null) }).strict()).max(20).default([]),
  importMaxChars: z.number().int().min(10000).max(4000000).default(4000000), importMaxConversations: z.number().int().min(1).max(128).default(128),
  importMaxBranches: z.number().int().min(1).max(32).default(16), importMaxMessages: z.number().int().min(1).max(20000).default(20000),
  importInputChars: z.number().int().min(12000).max(64000).default(16000), importSummaryChars: z.number().int().min(1000).max(8000).default(4000),
  importMaxTokens: z.number().int().min(2048).max(32768).default(8192), importTimeoutMs: z.number().int().min(1000).max(300000).default(180000),
  importMaxChunks: z.number().int().min(1).max(1000).default(200), continuationChars: z.number().int().min(8000).max(96000).default(24000),
  embedding: z.object({ provider: z.enum(['ollama', 'openai-compatible']), endpoint: z.string().url().refine(url => /^https?:/u.test(url)), model: z.string().min(1), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(), timeoutMs: z.number().int().min(100).max(120000).default(10000), minSimilarity: z.number().min(-1).max(1).default(0.25), batchSize: z.number().int().min(1).max(64).default(16) }).strict().optional(),
}).strict()
export type ResolvedConfig = z.infer<typeof configSchema>
