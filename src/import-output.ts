import type { StreamChunk } from '@deepseek-ai/dsh-llm'

export class ImportOutputError extends Error {
  constructor(readonly kind: 'empty' | 'truncated' | 'incomplete' | 'format', message: string) { super(message); this.name = 'ImportOutputError' }
}

/** DSH normalizes provider failures into finish chunks; never parse those as JSON. */
export async function readImportOutput(stream: AsyncIterable<StreamChunk>, signal: AbortSignal): Promise<string> {
  const blocks = new Map<number, string>(); let finished = false
  for await (const chunk of stream) {
    signal.throwIfAborted()
    if (chunk.type === 'text-delta') blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text)
    if (chunk.type === 'block-end' && chunk.block.type === 'text') blocks.set(chunk.index, chunk.block.text)
    if ([...blocks.values()].reduce((n, text) => n + text.length, 0) > 64000) throw new Error('历史提取输出超过 64,000 字符，未保存结果。请减小单次输入预算。')
    if (chunk.type !== 'finish') continue
    finished = true
    switch (chunk.reason.kind) {
      case 'stop': break
      case 'max-tokens': throw new ImportOutputError('truncated', '模型达到输出上限，未生成完整提取结果。请提高 importMaxTokens，或减小 importInputChars。')
      case 'aborted': throw new Error('历史提取已取消或超时，未保存本段结果。可重试；超时可提高 importTimeoutMs。')
      case 'error': {
        const status = chunk.reason.failure.status
        // Provider messages can echo private input or credentials; expose only bounded status facts.
        throw new Error(`历史提取的模型请求失败${Number.isInteger(status) ? `（HTTP ${status}）` : ''}。请检查所选模型、服务连接及 API 配置；已有归档和完成的分析段保留。`)
      }
      default: throw new Error('模型以非文本完成状态结束，未保存提取结果。请选择支持文本输出的模型后重试。')
    }
  }
  signal.throwIfAborted()
  if (!finished) throw new ImportOutputError('incomplete', '模型响应流提前中断，未收到完成状态；未保存本段结果，请重试。')
  const text = [...blocks.values()].join('')
  if (!text.trim()) throw new ImportOutputError('empty', '模型没有返回可见的提取正文，可能只输出了思考内容。请提高输出预算或更换模型后重试。')
  return text
}
