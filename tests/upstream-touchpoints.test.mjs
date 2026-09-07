import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repo = path.resolve(import.meta.dirname, '..')
const files = [
  'apps/desktop/index.html',
  'apps/desktop/src/main.tsx',
  'apps/desktop/vite.config.ts',
  'apps/desktop/src/app/layout-constants.ts',
  'apps/desktop/src/global.d.ts',
]

test('upstream touchpoints exist at the pinned submodule', () => {
  for (const relative of files) {
    const full = path.join(repo, 'upstream', relative)
    assert.equal(fs.existsSync(full), true, relative)
    assert.match(crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'), /^[0-9a-f]{64}$/)
  }
})
