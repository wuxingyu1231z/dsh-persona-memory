// Local development only: link dependencies into this project, never edit Harness.
import { readdir, readFile, mkdir, symlink, lstat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const harness = resolve(process.argv[2] ?? '../deepseek-harness-learning/deepseek-harness')
const packages = new Map()
for (const dir of [join(harness, 'vendor'), join(harness, 'packages')]) {
  async function scan(path, depth) {
    try { const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')); if (pkg.name) packages.set(pkg.name, path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (depth > 0) for (const child of await readdir(path, { withFileTypes: true })) if (child.isDirectory() && !['node_modules', 'lib', '.git'].includes(child.name)) await scan(join(path, child.name), depth - 1)
  }
  await scan(dir, 2)
}
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
// Refuse a different baseline before touching any project links.
for (const [name, expected] of Object.entries(manifest.peerDependencies)) {
  const location = packages.get(name) ?? join(harness, 'node_modules', name)
  const actual = JSON.parse(await readFile(join(location, 'package.json'), 'utf8')).version
  if (actual !== expected) throw new Error(`Harness version mismatch: ${name} ${actual}; plugin requires ${expected}. Do not link an older checkout.`)
}
for (const name of new Set([...Object.keys(manifest.devDependencies), ...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies ?? {})])) {
  let target = packages.get(name) ?? join(harness, 'node_modules', name)
  try { await lstat(target) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const entries = await readdir(join(harness, 'node_modules', '.pnpm'))
    const candidate = entries.filter(x => x.startsWith(name.replace('/', '+') + '@')).sort().at(-1)
    if (!candidate) throw new Error(`Missing local dependency: ${name}; run npm install instead.`)
    target = join(harness, 'node_modules', '.pnpm', candidate, 'node_modules', name)
    await lstat(target)
  }
  const dest = join(root, 'node_modules', name)
  await mkdir(resolve(dest, '..'), { recursive: true })
  try { await lstat(dest) } catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(target, dest, process.platform === 'win32' ? 'junction' : 'dir') }
}
await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
await writeFile(join(root, '.local-harness.json'), JSON.stringify({ harness }, null, 2) + '\n')
console.log('Local dependencies linked. Harness files were not modified.')
