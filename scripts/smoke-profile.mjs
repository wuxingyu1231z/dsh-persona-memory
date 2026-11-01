// Validate the tarball with the real dsh profile composer in an isolated home.
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { acceptsRuntime, readRuntimeConfig } from './runtime-config.mjs'
const exec = promisify(execFile)
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
let node = process.execPath
let cli
try {
  const installed = readRuntimeConfig()
  if (!acceptsRuntime(pkg, installed.version)) throw new Error('Installed test runtime is outside the supported range')
  node = installed.node
  cli = join(installed.runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  const { harness } = JSON.parse(await readFile('.local-harness.json', 'utf8'))
  const source = JSON.parse(await readFile(join(harness, 'package.json'), 'utf8'))
  if (!acceptsRuntime(pkg, source.version)) throw new Error('Source checkout is outside the supported range; prepare a supported runtime')
  cli = join(harness, 'apps/cli/lib/bin.js')
}
const base = resolve('.test-output')
await mkdir(base, { recursive: true })
const home = await mkdtemp(join(base, 'profile-smoke-'))
const profile = join(home, 'profiles', 'web')
const installed = join(profile, 'node_modules', pkg.name)
await mkdir(installed, { recursive: true })
await exec('tar', ['-xzf', resolve('releases', `${pkg.name}-${pkg.version}.tgz`), '--strip-components=1', '-C', installed])
await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [pkg.name]: `file:${installed}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pkg.name] } } }, null, 2))
const { stdout } = await exec(node, [cli, '--profile', 'web', '--dump-config'], { cwd: process.cwd(), env: { ...process.env, DSH_HOME: home }, maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true })
await writeFile(join(home, 'composed.yml'), stdout)
if (!stdout.includes('dsh-persona-memory') || !stdout.includes('persona-memory')) throw new Error('Plugin absent from the composed Web profile')
console.log('Packed tarball accepted by the real dsh Web profile composer. User profiles unchanged.')
