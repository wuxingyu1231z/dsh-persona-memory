/** Bound the serialized UTF-8 string, including JSON escaping, independently of dialogue size. */
export function uploadChunks(text: string): string[] {
  const encoder = new TextEncoder(), chunks: string[] = []
  for (let at = 0; at < text.length;) {
    let low = 1, high = Math.min(text.length - at, 60000)
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (encoder.encode(JSON.stringify(text.slice(at, at + mid))).length <= 60000) low = mid
      else high = mid - 1
    }
    // Keep surrogate pairs intact when crossing the RPC JSON boundary.
    if (at + low < text.length && /[\uD800-\uDBFF]/u.test(text[at + low - 1])) low--
    chunks.push(text.slice(at, at + low)); at += low
  }
  return chunks.length ? chunks : ['']
}
