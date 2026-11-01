/** Shared browser/Host validation for transport-only branch selections. */
export interface BranchSelection { tips: string[]; preferred: string | null }
export function branchSelection(value: unknown, mapping: Record<string, unknown>): BranchSelection | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('分支分片元数据无效')
  const { tips, preferred } = value as Record<string, unknown>
  if (!Array.isArray(tips) || !tips.length || tips.some(tip => typeof tip !== 'string' || !Object.hasOwn(mapping, tip))
    || new Set(tips).size !== tips.length || preferred !== null && typeof preferred !== 'string') throw new Error('分支分片引用无效或重复')
  return { tips: tips as string[], preferred: preferred as string | null }
}
