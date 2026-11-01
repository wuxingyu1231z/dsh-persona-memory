// Node 24 test hook: all public host packages use the copied, actually installed runtime.
import { registerHooks, createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { readRuntimeConfig } from './runtime-config.mjs'
const root = fileURLToPath(new URL('..', import.meta.url))
const config = readRuntimeConfig()
const { runtime, version, deps = resolve(root, `.test-output/compat-deps-${config.version}`) } = config
const requireHost = createRequire(pathToFileURL(join(runtime, 'package.json')))
const requireTests = createRequire(pathToFileURL(join(deps, 'package.json')))
let resolving = false
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/') && !resolving) {
    const name = specifier.split('/').slice(0, 2).join('/')
    const resolver = existsSync(join(runtime, 'node_modules', name, 'package.json')) ? requireHost
      : existsSync(join(deps, 'node_modules', name, 'package.json')) ? requireTests : null
    if (resolver) {
      resolving = true
      try { return { url: pathToFileURL(resolver.resolve(specifier)).href, shortCircuit: true } }
      finally { resolving = false }
    }
    if (name.startsWith('@deepseek-ai/dsh-')) throw new Error(`Missing ${version} host test dependency: ${name}`)
  }
  return next(specifier, context)
} })
