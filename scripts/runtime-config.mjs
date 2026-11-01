import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import semver from 'semver'

const root = fileURLToPath(new URL('..', import.meta.url))
export function readRuntimeConfig() {
  return JSON.parse(readFileSync(resolve(root, process.env.PERSONA_TEST_RUNTIME_CONFIG ?? '.installed-runtime.json'), 'utf8'))
}
export function acceptsRuntime(pkg, version) {
  return semver.satisfies(version, pkg.engines.dsh, { includePrerelease: true })
}
