// Use an isolated headless Edge profile; never attaches to a user's browser.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import './preview-ui.mjs'
const exec = promisify(execFile)
const edge = process.env.PERSONA_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const base = resolve('.test-output/ui-preview')
function luminance(value) {
  const rgb = value.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  assert.equal(rgb?.length, 3, `Unexpected computed color: ${value}`)
  return rgb.map(c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0)
}
const cases = [
  { name: 'dark-management', theme: 'dark', width: 1100 },
  { name: 'light-management', theme: 'light', width: 1100 },
  { name: 'dark-history', theme: 'dark', tab: 'history', width: 1100 },
  { name: 'dark-mobile', theme: 'dark', tab: 'history', width: 400 },
  { name: 'dark-history-create', theme: 'dark', tab: 'history', create: '1', width: 1100 },
  { name: 'mobile-history-create', theme: 'dark', tab: 'history', create: '1', width: 400 },
  { name: 'dark-continuation-workspace', theme: 'dark', tab: 'history', continuation: '1', width: 1100 },
  { name: 'light-continuation-workspace', theme: 'light', tab: 'history', continuation: '1', width: 1100 },
  { name: 'mobile-continuation-workspace', theme: 'dark', tab: 'history', continuation: '1', width: 400 },
  { name: 'dark-personas', theme: 'dark', personas: '1', width: 900 },
  { name: 'mobile-personas', theme: 'dark', personas: '1', width: 400 },
]
const reports = []
for (const item of cases) {
  const profile = join(base, `browser-${item.name}`); await mkdir(profile, { recursive: true })
  const url = pathToFileURL(join(base, 'index.html'))
  url.search = new URLSearchParams(Object.entries(item).filter(([k]) => ['theme', 'tab', 'personas', 'create', 'continuation'].includes(k)))
  let address = url.href
  // Windows headless top-level windows have a minimum width; an iframe gives the exact mobile viewport.
  if (item.width < 500) {
    const wrapper = join(base, 'mobile-frame.html')
    await writeFile(wrapper, `<html><meta charset="utf-8"><style>body{margin:0}iframe{border:0;width:${item.width}px;height:1000px}</style><script>addEventListener('message', e => {const r=document.createElement('script');r.id='visual-report';r.type='application/json';r.textContent=JSON.stringify(e.data);document.body.append(r)})</script><iframe src="${url.href}"></iframe></html>`)
    address = pathToFileURL(wrapper).href
  }
  const { stdout } = await exec(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking', `--user-data-dir=${profile}`, `--window-size=${item.width},1000`, '--virtual-time-budget=1500', `--screenshot=${join(base, item.name + '.png')}`, '--dump-dom', address], { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  await writeFile(join(base, item.name + '.html'), stdout)
  const match = stdout.match(/<script id="visual-report" type="application\/json">(.*?)<\/script>/s)
  assert.ok(match, `Browser fixture failed: ${item.name}`)
  const report = JSON.parse(match[1]); if (!item.personas) assert.ok(report.colors.length)
  assert.equal(report.hasExpiryInput, false); assert.equal(report.hasReview, false)
  if (item.width < 500) assert.equal(report.viewport, item.width)
  for (const pair of report.colors) {
    const [a, b] = [luminance(pair.color), luminance(pair.background)].sort((a, b) => b - a)
    assert.ok((a + .05) / (b + .05) >= 4.5, `Unreadable idle option in ${item.name}: ${JSON.stringify(pair)}`)
  }
  assert.equal(report.overflow, false, `${item.name} overflows horizontally`)
  if (item.personas) { assert.equal(report.hasImport, false); assert.equal(report.personaCount, 3) }
  if (item.tab === 'history') assert.equal(report.hasImport, true)
  if (item.create) assert.equal(report.hasCreatePersona, true)
  if (item.continuation) { assert.equal(report.hasWorkspacePicker, true); assert.equal(report.selectedWorkspace, 'workspace-default') }
  reports.push({ name: item.name, ...report }); console.log(`Browser visual check passed: ${item.name}`)
}
await writeFile(join(base, 'report.json'), JSON.stringify(reports, null, 2) + '\n')
