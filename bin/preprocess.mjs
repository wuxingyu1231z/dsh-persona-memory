#!/usr/bin/env node
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { resolve, join, basename, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { preprocessHistory, historyParts } from '../lib/preprocess.js'
import { parseHistory } from '../lib/import-parser.js'

// Local-only utility: never reads credentials or contacts a model/provider.
const [source, destination, ...extra] = process.argv.slice(2)
if (!source || !destination || extra.length) {
  console.error('Usage: dsh-memory-preprocess <export.json|export-directory|chat.md> <new-output-directory>')
  process.exitCode = 1
} else {
  try {
    let input = resolve(source)
    const sourceStat = await stat(input)
    if (sourceStat.isDirectory()) input = join(input, 'conversations.json')
    const inputStat = await stat(input)
    if (!inputStat.isFile() || inputStat.size > 64000000) throw new Error('Input must be a file of at most 64 MB.')
    const output = resolve(destination)
    const inside = relative(resolve(sourceStat.isDirectory() ? source : input), output)
    if (inside === '' || !inside.startsWith('..') && !isAbsolute(inside)) throw new Error('Choose an output directory outside the original export.')
    const bytes = await readFile(input)
    const sha = data => createHash('sha256').update(data).digest('hex')
    const prepared = preprocessHistory(basename(input), bytes.toString('utf8'))
    const parts = historyParts(prepared)
    const parsed = parts.map(part => parseHistory(basename(input), part.text, part.format))
    const records = parsed.flatMap(batch => batch.conversations)
    if (records.length !== prepared.conversations.reduce((sum, c) => sum + c.branches, 0)) throw new Error('Conversation/branch count mismatch.')
    const format = prepared.conversations[0].format
    const cleaned = format === 'json' ? `[${prepared.conversations.map(c => c.text).join(',')}]` : prepared.conversations[0].text
    const filename = format === 'json' ? 'conversations.cleaned.json' : 'conversation.cleaned.md'
    const report = {
      version: 1, input: basename(input), sourceSha256: sha(bytes), sourceBytes: bytes.length,
      sourceCharacters: prepared.originalCharacters, output: filename, outputSha256: sha(cleaned), outputBytes: Buffer.byteLength(cleaned),
      sourceConversations: prepared.conversations.length, branchRecords: records.length,
      uniqueVisibleMessages: prepared.conversations.reduce((sum, c) => sum + c.messages, 0),
      branchMessageOccurrences: records.reduce((sum, c) => sum + c.messages.length, 0),
      removedFragments: prepared.removedFragments, removedThinkingCharacters: prepared.removedThinkingCharacters,
      automaticTransportParts: parts.length, skipped: prepared.skipped,
      notes: ['All conversations retained together. Branches and visible text are preserved.', 'Thinking, tool activity and attachment bodies were removed when identified structurally.', 'No model was called. Original files are read-only.'],
    }
    if (sha(await readFile(input)) !== report.sourceSha256) throw new Error('Original file changed while processing; no output written.')
    // Never overwrite an existing output folder or source file.
    await mkdir(output, { recursive: false })
    await writeFile(join(output, filename), cleaned, { flag: 'wx', mode: 0o600 })
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ directory: output, ...report }, null, 2))
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
