// Run normal checks on the installed Node, with host imports pinned to the installed DSH copy.
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readRuntimeConfig, acceptsRuntime } from './runtime-config.mjs'
const root = fileURLToPath(new URL('..', import.meta.url))
const { node, version } = readRuntimeConfig()
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (!acceptsRuntime(pkg, version)) throw new Error(`Test runtime ${version} is outside ${pkg.engines.dsh}`)
const skipBuild = process.argv.includes('--skip-build')
const sourceTests = pkg.scripts.test.replace('node --import tsx --test ', '').split(' ')
for (const args of [
  ...(!skipBuild ? [['node_modules/typescript/bin/tsc', '--noEmit']] : []),
  ['--import', 'tsx', '--import', './scripts/use-installed-runtime.mjs', '--test', ...sourceTests],
  ...(!skipBuild ? [['scripts/build.mjs']] : []),
  ['--import', './scripts/use-installed-runtime.mjs', '--test', 'tests/package.test.mjs', 'tests/client-runtime.test.mjs', 'tests/runtime-compat.test.mjs', 'tests/workspace-runtime.test.mjs'],
]) {
  const child = spawn(node, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  if (status !== 0) process.exit(status ?? 1)
}
