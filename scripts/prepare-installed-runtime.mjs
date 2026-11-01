// Copy the installed public runtime into an isolated test directory. The installation is read-only.
import { createRequire } from 'node:module'
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptsRuntime } from './runtime-config.mjs'
const project = fileURLToPath(new URL('..', import.meta.url))
const installation = resolve(process.argv[2] ?? 'D:/learn/dsh')
const require = createRequire(import.meta.url)
let asar
try { asar = require('@electron/asar') }
catch { asar = require(resolve(project, '../deepseek-harness-learning/deepseek-harness/node_modules/.pnpm/@electron+asar@3.4.1/node_modules/@electron/asar')) }
const archive = join(installation, 'resources', 'app.asar')
const manifest = JSON.parse(asar.extractFile(archive, join('dsh', 'package.json')).toString())
const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
if (!acceptsRuntime(pkg, manifest.version)) throw new Error(`Installed runtime ${manifest.version} is outside ${pkg.engines.dsh}`)
const target = resolve(project, '.test-output', `dsh-runtime-${manifest.version}`, 'dsh')
const { header } = asar.getRawHeader(archive)
let count = 0
async function copy(node, parts) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const next = [...parts, name]
    const destination = resolve(target, ...next)
    const inside = relative(target, destination)
    if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unsafe archive path')
    if (entry.link) throw new Error('Archive links require explicit review')
    if (entry.files) { await mkdir(destination, { recursive: true }); await copy(entry, next) }
    else {
      if (entry.unpacked) await copyFile(join(archive + '.unpacked', 'dsh', ...next), destination)
      else await writeFile(destination, asar.extractFile(archive, join('dsh', ...next)))
      count++
    }
  }
}
await mkdir(target, { recursive: true })
await copy(header.files.dsh, [])
const node = join(installation, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
await writeFile(join(project, '.installed-runtime.json'), JSON.stringify({ installation, runtime: target, node, version: manifest.version }, null, 2) + '\n')
console.log(`Copied ${count} installed runtime files for ${manifest.version}. Installation unchanged.`)
