import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repo = path.resolve(import.meta.dirname, '..')
const contract = fs.readFileSync(path.join(repo, 'upstream/apps/desktop/src/global.d.ts'), 'utf8')
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'src/bridge/manifest.json'), 'utf8'))

test('manifest pins the ADR upstream commit', () => {
  assert.equal(manifest.upstreamSha, 'f159e581c7afd22a5c94652c569e3859f1b994d2')
  assert.equal(fs.readFileSync(path.join(repo, 'upstream/.git'), 'utf8').trim().startsWith('gitdir:'), true)
})

test('manifest accounts for every required top-level bridge method', () => {
  const block = contract.match(/interface Window[\s\S]*?hermesDesktop:\s*\{([\s\S]*?)^    \}\s*^  \}/m)?.[1] ?? ''
  const required = [...block.matchAll(/^      ([A-Za-z_$][A-Za-z0-9_$]*):/gm)].map(match => match[1])
  assert.deepEqual(required.filter(name => !manifest.methods[name]), [])
  for (const status of Object.values(manifest.methods)) {
    assert.ok(['impl', 'stub', 'omit'].includes(status))
  }
})
