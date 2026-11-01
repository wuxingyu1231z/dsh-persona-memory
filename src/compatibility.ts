/** Probe required capabilities before mounting UI or opening the memory store. */
export function requireMethods(surface: string, methods: Record<string, unknown>): void {
  const missing = Object.keys(methods).filter(name => typeof methods[name] !== 'function')
  if (missing.length) throw new Error(`当前 DSH 缺少插件所需的接口（${surface}）：${missing.join(', ')}。请更新插件以适配此 DSH 版本。`)
}
