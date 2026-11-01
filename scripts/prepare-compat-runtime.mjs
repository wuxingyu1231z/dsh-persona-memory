// Fetch official npm modules into disposable fixtures, without changing project dependencies.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { acceptsRuntime } from './runtime-config.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this command with npm run prepare:compat -- <versions>')
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5']
const extra = ['dsh-app-boot', 'dsh-storage', 'dsh-storage-domain', 'dsh-storage-json', 'dsh-fs-local'].map(name => '@deepseek-ai/' + name)
for (const version of versions) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !acceptsRuntime(pkg, version)) throw new Error(`Unsupported fixture version: ${version}`)
  const folder = resolve(root, `.test-output/compat-deps-${version}`)
  await mkdir(folder, { recursive: true })
  let previous = {}
  try { previous = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')).dependencies ?? {} }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  // Keep any existing development tools: a local node_modules link may still use them.
  const fixture = { name: 'persona-memory-official-runtime-check', private: true, type: 'module', dependencies: { ...previous } }
  delete fixture.dependencies[pkg.name]
  const hostNames = [...new Set([...Object.keys(pkg.devDependencies), ...extra].filter(name => name.startsWith('@deepseek-ai/dsh-')))]
  for (const name of hostNames) fixture.dependencies[name] = version
  fixture.dependencies['@deepseek-ai/cordis'] = pkg.devDependencies['@deepseek-ai/cordis']
  for (let round = 0; round < 12; round++) {
    await writeFile(join(folder, 'package.json'), JSON.stringify(fixture, null, 2) + '\n')
    const child = spawn(process.execPath, [npm, 'install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', resolve(root, '.test-output/npm-compat-cache')], { cwd: folder, windowsHide: true, stdio: 'inherit' })
    const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
    if (status !== 0) throw new Error(`npm fixture installation failed for ${version}`)
    let added = 0
    // Official packages declare host services as peers. Resolve those recursively at the same DSH version.
    for (const name of await readdir(join(folder, 'node_modules/@deepseek-ai'))) {
      const manifest = JSON.parse(await readFile(join(folder, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8'))
      for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
        if (!peer.startsWith('@deepseek-ai/') || fixture.dependencies[peer]) continue
        fixture.dependencies[peer] = peer === '@deepseek-ai/dsh' || peer.startsWith('@deepseek-ai/dsh-') ? version : range
        added++
      }
    }
    if (!added) break
    if (round === 11) throw new Error('Official host dependency closure did not converge')
  }
  console.log(`Prepared official DSH ${version} modules in ${folder}`)
}
