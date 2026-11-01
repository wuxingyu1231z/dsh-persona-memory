// Exercise the actual installed DSH package-manager transaction in a disposable home.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, realpath, stat } from 'node:fs/promises'
import { resolve, join, dirname, delimiter } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { acceptsRuntime, readRuntimeConfig } from './runtime-config.mjs'
const exec = promisify(execFile)
const project = fileURLToPath(new URL('..', import.meta.url))
const { installation, runtime, node, version } = readRuntimeConfig()
const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
assert.ok(acceptsRuntime(pkg, version))
const boot = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href)
const base = resolve(project, '.test-output'); await mkdir(base, { recursive: true })
const home = await mkdtemp(join(base, 'installed-transaction-'))
const profile = join(home, 'profiles/web')
const pnpm = join(installation, 'resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs')
const env = { ...process.env, DSH_HOME: home, PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ''}`, CI: 'true', npm_config_update_notifier: 'false' }
async function install(filename, targetRuntime = runtime) {
  const operations = await import(pathToFileURL(join(targetRuntime, 'node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js')).href)
  const context = { profile: 'web', home, dir: profile, installAnchor: join(targetRuntime, 'node_modules/@deepseek-ai/dsh/package.json'), cwd: project }
  return operations.runPluginCommand(context, [
  'add', filename, '--ignore-scripts',
  '--store-dir', join(base, 'pnpm-store'), `--config.cache-dir=${join(base, 'pnpm-cache')}`, `--config.state-dir=${join(base, 'pnpm-state')}`,
], { command: node, args: [pnpm], env, execution: 'service', outputBytes: 32000, lookupTimeoutMs: 30000, idleTimeoutMs: 60000, signal: AbortSignal.timeout(180000), onOutput: (text, kind) => process[kind].write(text) })
}
const upgrade = process.argv.includes('--upgrade')
const upgradeFrom = process.env.PERSONA_UPGRADE_FROM ?? '0.8.3-alpha.1'
const upgradeHost = '0.2.1-rc.3'
const memoryRoot = join(home, 'memory')
let legacy
let oldPluginRejectedByNewHost = false
const storeEntry = () => realpath(join(profile, 'node_modules', pkg.name, 'lib/store.js'))
if (upgrade) {
  // Reproduce the user upgrading DSH as well as the plugin, without bypassing either host's guards.
  const previousRuntime = resolve(process.env.PERSONA_UPGRADE_RUNTIME ?? join(base, `dsh-runtime-${upgradeHost}`, 'dsh'))
  await stat(join(previousRuntime, 'package.json'))
  const old = await install(join(project, 'releases', `${pkg.name}-${upgradeFrom}.tgz`), previousRuntime); assert.equal(old.exitCode, 0, old.output)
  const previousManifest = JSON.parse(await readFile(join(profile, 'node_modules', pkg.name, 'package.json'), 'utf8'))
  const rejection = boot.evaluatePluginCompatibility(previousManifest, {}, version)
  oldPluginRejectedByNewHost = !acceptsRuntime(previousManifest, version)
  if (oldPluginRejectedByNewHost) { assert.ok(rejection, 'new host must reproduce the old plugin compatibility rejection'); assert.equal(rejection.exempted, false) }
  else assert.equal(rejection, undefined)
  const { MemoryStore } = await import(pathToFileURL(await storeEntry()).href)
  const store = new MemoryStore(memoryRoot); await store.initialize()
  const persona = await store.getPersona('research-mentor')
  await store.savePersona({ id: persona.id, name: persona.name, description: persona.description, prompt: '独立升级验证：保留用户定义的核心' }, persona.revision)
  const core = await readFile(join(memoryRoot, 'personas/research-mentor/PERSONA.md'), 'utf8')
  const input = { personaId: 'research-mentor', projectId: null, key: '升级记录', content: '旧包写入的记忆', category: 'fact', pinned: false }
  const global = await store.remember(input, 0, { kind: 'user' })
  const projectMemory = await store.remember({ ...input, projectId: 'upgrade-project', content: '旧项目记忆' }, 0, { kind: 'user' })
  await store.select('upgrade-session', 'daily-companion')
  legacy = { global, projectMemory, core }
}
const result = await install(join(project, 'releases', `${pkg.name}-${pkg.version}.tgz`))
assert.equal(result.exitCode, 0, result.output)
const installed = JSON.parse(await readFile(join(profile, 'node_modules', pkg.name, 'package.json'), 'utf8'))
assert.equal(installed.version, pkg.version)
assert.equal(boot.evaluatePluginCompatibility(installed, {}, version), undefined)
assert.deepEqual(boot.readProfileVersionExemptions(profile), {})
const selection = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
assert.ok(selection.dsh.profile.bundles.includes(pkg.name))
if (legacy) {
  // pnpm can replace files at the same URL. A fresh process models the required Host restart.
  const restart = `import { pathToFileURL } from 'node:url'; const { MemoryStore } = await import(pathToFileURL(process.argv[1]).href); const store = new MemoryStore(process.argv[2]); await store.initialize(); console.log(JSON.stringify({ memories: await store.memories('research-mentor'), selection: await store.selection('upgrade-session', 'research-mentor') }));`
  const { stdout: verified } = await exec(node, ['--input-type=module', '-e', restart, await storeEntry(), memoryRoot], { cwd: project, env, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true })
  const { memories, selection: restoredSelection } = JSON.parse(verified)
  assert.deepEqual(memories.find(m => m.id === legacy.global.id), legacy.global)
  assert.deepEqual(memories.find(m => m.id === legacy.projectMemory.id), legacy.projectMemory)
  assert.equal(await readFile(join(memoryRoot, 'personas/research-mentor/PERSONA.md'), 'utf8'), legacy.core)
  assert.equal(restoredSelection, 'daily-companion')
  await readFile(join(memoryRoot, 'personas/research-mentor/projects/upgrade-project/memories', legacy.projectMemory.id + '.md'))
  assert.match(await readFile(join(memoryRoot, 'personas/research-mentor/MEMORY.md'), 'utf8'), /PROFILE\.md/)
  await assert.rejects(readFile(join(memoryRoot, 'personas/research-mentor/memories', legacy.projectMemory.id + '.md')), /ENOENT/)
}
const { stdout } = await exec(node, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--dump-config'], { cwd: project, env, maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true })
assert.ok(stdout.includes('dsh-persona-memory') && stdout.includes('persona-memory'))
await writeFile(join(home, 'composed.yml'), stdout)
const report = JSON.stringify({ version: pkg.version, dsh: version, transaction: 'passed', compatibility: 'passed', exemptions: {}, profileComposition: 'passed', ...(upgrade ? { upgradeFrom, upgradeHost, oldPluginRejectedByNewHost, memoryPreservation: 'passed' } : {}), home, logPath: result.logPath, userProfileModified: false }, null, 2) + '\n'
await writeFile(join(base, `installed-transaction-report-${version}.json`), report)
await writeFile(join(base, 'installed-transaction-report.json'), report)
console.log('Actual DSH installation transaction and profile composition passed in an isolated home. No version exemption; user profiles unchanged.')
