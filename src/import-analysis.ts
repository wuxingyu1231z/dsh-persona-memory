import { analysisSchema, type ImportAnalysis } from './import-schema.ts'
import { ImportOutputError } from './import-output.ts'

/** Accept a complete object with presentation wrappers; never repair missing JSON or invent fields. */
export function parseImportAnalysis(raw: string): ImportAnalysis {
  const text = raw.replace(/^\uFEFF/u, '').trim()
  if (!text) throw new ImportOutputError('empty', '模型未返回提取正文。')
  let value: unknown
  try { value = JSON.parse(text) }
  catch {
    // Locate only top-level objects, respecting quoted braces and escapes.
    const objects: string[] = []; let start = -1, depth = 0, quoted = false, escaped = false
    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      if (start < 0) { if (char === '{') { start = i; depth = 1 } continue }
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
      if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) { objects.push(text.slice(start, i + 1)); start = -1 }
    }
    if (start >= 0 || objects.length !== 1) throw new ImportOutputError('format', '模型返回的 JSON 不完整或包含多个对象，未保存本段结果。', 'Return exactly one complete JSON object, with no prose or Markdown.')
    try { value = JSON.parse(objects[0]) }
    catch { throw new ImportOutputError('format', '模型返回的 JSON 语法无效，未保存本段结果。', 'Use quoted JSON keys and strings, escaped newlines and double quotes, no trailing commas.') }
  }
  const result = analysisSchema.safeParse(value)
  if (result.success) return result.data
  // Never include provider text, unknown property names, evidence or Zod input values in diagnostics.
  const fields = new Set(['summary', 'personaDraft', 'name', 'description', 'prompt', 'topic', 'proposals', 'key', 'content', 'category', 'scope', 'intent', 'evidence', 'messageId', 'targetId'])
  const details = result.error.issues.slice(0, 6).map(issue => `${issue.path.map(p => typeof p === 'number' ? p : fields.has(String(p)) ? p : '?').join('.') || 'root'} (${issue.code})`).join('; ')
  throw new ImportOutputError('schema', `模型返回了 JSON，但字段不符合提取格式：${details}。未保存本段结果。`, `Fix these schema fields: ${details}. Follow all field types, enum values and length limits in the system instructions.`)
}
