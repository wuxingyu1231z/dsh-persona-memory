import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { contribution, descriptor } from '../src/transport.ts'
import { zh, en } from '../src/client/locales.ts'
test('Host and Client share strict transport schemas', () => {
  assert.equal(contribution.descriptors[0], descriptor)
  const codec = descriptor.parameters[1].codec
  assert.equal(codec.mode, 'strict')
  if (codec.mode !== 'strict') throw new Error('strict codec required')
  assert.throws(() => codec.create().parse({ op: 'select', personaId: '../../escape' }))
  assert.throws(() => codec.create().parse({ op: 'snapshot', extra: true }))
  assert.deepEqual(codec.create().parse({ op: 'snapshot' }), { op: 'snapshot' })
})
test('Web and Desktop share one client entry and no install-time scripts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.scripts.postinstall, undefined)
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})
