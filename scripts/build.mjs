import { build } from 'tsdown'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import semver from 'semver'
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const pluginManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
for (const [name, expected] of Object.entries(pluginManifest.peerDependencies)) {
  const dependency = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'))
  if (!semver.satisfies(dependency.version, expected, { includePrerelease: true })) throw new Error(`Build dependency mismatch: ${name} ${dependency.version}; expected ${expected}. Link or install a supported DSH baseline first.`)
}
const nestedRequire = createRequire(require.resolve('proper-lockfile/package.json'))
const notices = ['# Bundled dependency notices\n']
for (const name of ['zod', 'js-yaml', 'proper-lockfile', 'graceful-fs', 'retry', 'signal-exit']) {
  let manifestPath
  try { manifestPath = require.resolve(name + '/package.json') } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; manifestPath = nestedRequire.resolve(name + '/package.json') }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const folder = dirname(manifestPath)
  const license = (await readdir(folder)).find(file => /^(?:license|licence)(?:\.(?:md|txt))?$/i.test(file))
  if (!license) throw new Error('Missing bundled license: ' + name)
  notices.push(`## ${name} ${manifest.version}\n\n${await readFile(join(folder, license), 'utf8')}\n`)
}
await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), notices.join('\n').trimEnd() + '\n')
const output = join(root, 'lib')
if (dirname(output) !== root.replace(/[\\/]$/, '')) throw new Error('Unexpected build output directory')
await rm(output, { recursive: true, force: true })
await mkdir('releases', { recursive: true })
await build({ entry: ['src/index.ts', 'src/store.ts', 'src/preprocess.ts', 'src/import-parser.ts'], outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'node24', dts: false, clean: false, sourcemap: true,
  deps: { neverBundle: [/^@deepseek-ai\//], alwaysBundle: ['zod', 'js-yaml', 'proper-lockfile'] } })
await build({ entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2022', dts: false, clean: false,
  deps: { neverBundle: ['react', 'react/jsx-runtime'], alwaysBundle: [/^zod/] },
  outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({id:"dsh-persona-memory",factory:(require)=>{', intro: 'var module = {exports: {}}; var exports = module.exports;', footer: 'return module.exports; }});' } })
// Emit public domain declarations independently of browser transport types.
import ts from 'typescript'
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, '.')
const program = ts.createProgram(['src/index.ts', 'src/store.ts', 'src/preprocess.ts', ...parsed.fileNames.filter(file => file.endsWith('.d.ts'))], { ...parsed.options, noEmit: false, emitDeclarationOnly: true, outDir: 'lib/types', rootDir: 'src' })
const result = program.emit()
const errors = ts.getPreEmitDiagnostics(program).concat(result.diagnostics).filter(d => d.category === ts.DiagnosticCategory.Error)
if (errors.length) { console.error(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: ts.sys.getCurrentDirectory, getCanonicalFileName: x => x, getNewLine: () => '\n' })); process.exitCode = 1 }
