// Build once against the minimum supported API; exercise that same artifact on each runtime.
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { acceptsRuntime, readRuntimeConfig } from './runtime-config.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5']
let current
try { current = readRuntimeConfig() }
catch (error) { if (error.code !== 'ENOENT') throw error; current = { node: process.execPath } }
const output = resolve(root, '.test-output/compatibility-matrix')
await mkdir(output, { recursive: true })
async function fingerprint(dir) {
  const hash = createHash('sha256')
  async function walk(path, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name
      if (entry.isDirectory()) await walk(join(path, entry.name), name + '/')
      else { hash.update(name); hash.update(await readFile(join(path, entry.name))) }
    }
  }
  await walk(dir); return hash.digest('hex')
}
const cases = []
for (const version of versions) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !acceptsRuntime(pkg, version)) throw new Error(`Unsupported test version: ${version}`)
  const deps = resolve(root, `.test-output/compat-deps-${version}`)
  let runtime = resolve(root, `.test-output/dsh-runtime-${version}/dsh`)
  let provenance = 'desktop-runtime-copy'
  try { await access(join(runtime, 'package.json')) }
  catch { runtime = deps; provenance = 'official-npm-packages' }
  const host = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/package.json'), 'utf8'))
  if (host.version !== version) throw new Error(`Wrong runtime for ${version}`)
  await access(join(deps, 'node_modules/@deepseek-ai/dsh-agent-loop-testkit/package.json'))
  const config = join(output, `runtime-${version}.json`)
  await writeFile(config, JSON.stringify({ ...current, version, runtime, deps }, null, 2) + '\n')
  let log = ''
  const child = spawn(current.node, ['scripts/check-installed.mjs', ...(cases.length ? ['--skip-build'] : [])], {
    cwd: root, windowsHide: true, env: { ...process.env, PERSONA_TEST_RUNTIME_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', chunk => { log += chunk; target.write(chunk) })
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  const logPath = join(output, `${version}.log`); await writeFile(logPath, log)
  if (status !== 0) throw new Error(`Compatibility checks failed for ${version}; see ${logPath}`)
  const artifact = await fingerprint(join(root, 'lib'))
  if (cases.length && cases[0].artifact !== artifact) throw new Error('The shared build changed during matrix checks')
  const checks = [...log.matchAll(/(?:^|\n)(?:ℹ |# )tests (\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0)
  if (!checks) throw new Error('No completed test summary found')
  cases.push({ version, provenance, checks, artifact, logPath, status: 'passed' })
}
await writeFile(join(output, 'report.json'), JSON.stringify({ pluginVersion: pkg.version, supportedRange: pkg.engines.dsh, cases }, null, 2) + '\n')
console.log(`One shared build passed on ${cases.map(c => `${c.version} (${c.checks} checks)`).join(', ')}.`)
