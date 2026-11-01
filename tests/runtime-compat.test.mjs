import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import semver from 'semver'
import { readRuntimeConfig, acceptsRuntime } from '../scripts/runtime-config.mjs'

test('one release accepts rc.3/rc.4/rc.5 and later 0.2.x versions without an exemption, with a 0.3 boundary', async () => {
  const { runtime, version } = readRuntimeConfig()
  const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href)
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(getDshRuntimeVersion(), version)
  assert.ok(acceptsRuntime(pkg, version))
  const baseline = pkg.devDependencies['@deepseek-ai/dsh-agent']
  assert.ok(semver.valid(baseline), 'development baseline remains reproducible')
  for (const [name, requirement] of Object.entries(pkg.devDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(requirement, baseline, `development API baseline: ${name}`)
  }
  for (const [name, requirement] of Object.entries(pkg.peerDependencies)) {
    const installed = JSON.parse(await readFile(join(runtime, 'node_modules', name, 'package.json'), 'utf8'))
    assert.ok(semver.satisfies(installed.version, requirement, { includePrerelease: true }), name)
  }
  for (const accepted of ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.1-rc.6', '0.2.1', '0.2.2-alpha.1', '0.2.2', '0.2.99']) {
    assert.equal(evaluatePluginCompatibility(pkg, {}, accepted), undefined, accepted)
    // Engines take precedence in DSH, so verify the peer ranges independently too.
    const { engines, ...peersOnly } = pkg
    assert.equal(evaluatePluginCompatibility(peersOnly, {}, accepted), undefined, `peer range: ${accepted}`)
  }
  for (const rejected of ['0.1.7-alpha.2', '0.2.1-rc.2', '0.3.0-alpha.1', '0.3.0', '1.0.0']) {
    const refusal = evaluatePluginCompatibility(pkg, {}, rejected)
    assert.ok(refusal, rejected); assert.equal(refusal.exempted, false)
  }
  const previous = { ...pkg, version: '0.8.2-alpha.1', engines: { ...pkg.engines, dsh: '0.2.1-rc.5' } }
  assert.ok(evaluatePluginCompatibility(previous, {}, '0.2.1-rc.3'), 'old exact-version manifest reproduces the problem')
})
