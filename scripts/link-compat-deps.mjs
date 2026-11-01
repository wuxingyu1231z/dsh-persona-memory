// Development only: link this project's dependencies to an isolated current-version install.
import { readFile, mkdir, lstat, symlink, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join, relative, isAbsolute } from 'node:path'
const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = process.argv[2] ?? pkg.devDependencies['@deepseek-ai/dsh-agent']
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('A concrete development version is required')
const base = resolve(root, `.test-output/compat-deps-${version}/node_modules`)
const names = new Set([...Object.keys(pkg.devDependencies), ...Object.keys(pkg.peerDependencies), ...Object.keys(pkg.dependencies)])
// Preflight before changing any links, so a missing dependency leaves the old environment usable.
for (const name of names) await lstat(join(base, name))
for (const name of names) {
  const target = join(base, name)
  const dest = resolve(root, 'node_modules', name)
  const inside = relative(join(root, 'node_modules'), dest)
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unexpected dependency destination')
  let old
  try { old = await lstat(dest) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (old && !old.isSymbolicLink()) throw new Error(`Refusing to replace an ordinary directory: ${dest}`)
  if (old) await unlink(dest)
  await mkdir(resolve(dest, '..'), { recursive: true })
  await symlink(target, dest, process.platform === 'win32' ? 'junction' : 'dir')
}
await writeFile(join(root, '.compat-deps.json'), JSON.stringify({ base, version }, null, 2) + '\n')
console.log(`Project dependencies now use DSH ${version}; host installation unchanged.`)
