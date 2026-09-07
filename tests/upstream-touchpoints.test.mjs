import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repo = path.resolve(import.meta.dirname, '..')

const touchpoints = {
  'apps/desktop/index.html': '7c5f71436a35af0cfeaa1f24350f83844105a5d6c527257cfd264ce77c59a1fb',
  'apps/desktop/src/main.tsx': '17caa231b60424b367005934e3e504b2aff62092911ca603b5143fa1ac3d890f',
  'apps/desktop/vite.config.ts': '4b865567f30cc356d7cb33b9b2f31c3b6cc9a2ed39cb2ca1508c62cd909fb2d6',
  'apps/desktop/src/app/layout-constants.ts': '5feb17140088ae55804d79ac5db27bfb6317a4f0fe9a5b431b11b318f44e0e95',
  'apps/desktop/src/global.d.ts': 'de9c0e05f048e6387bc4562ba2211dbabcc526e53f669202f965c3dfef5aa2cd',
}

test('upstream touchpoints exist at the pinned submodule', () => {
  for (const relative of Object.keys(touchpoints)) {
    const full = path.join(repo, 'upstream', relative)
    assert.equal(fs.existsSync(full), true, `${relative} must exist`)
  }
})

test('upstream touchpoint hashes match snapshots', () => {
  const mismatches = []
  for (const [relative, expected] of Object.entries(touchpoints)) {
    const full = path.join(repo, 'upstream', relative)
    const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    if (actual !== expected) {
      mismatches.push({ file: relative, expected, actual })
    }
  }
  if (mismatches.length > 0) {
    const report = mismatches.map(m => `  ${m.file}\n    expected: ${m.expected}\n    actual:   ${m.actual}`).join('\n')
    assert.fail(
      `Upstream touchpoints changed — review before updating snapshots:\n${report}\n\n` +
      'If the changes are safe, update the hashes in tests/upstream-touchpoints.test.mjs'
    )
  }
})

test('layout-constants exports SIDEBAR_DOCK_MIN_WIDTH_PX = 640', () => {
  const src = fs.readFileSync(path.join(repo, 'upstream/apps/desktop/src/app/layout-constants.ts'), 'utf8')
  assert.match(src, /SIDEBAR_DOCK_MIN_WIDTH_PX\s*=\s*640/)
})

test('global.d.ts declares hermesDesktop on Window', () => {
  const src = fs.readFileSync(path.join(repo, 'upstream/apps/desktop/src/global.d.ts'), 'utf8')
  assert.match(src, /hermesDesktop:\s*\{/)
  assert.match(src, /interface HermesNotification/)
  assert.match(src, /interface HermesSelectPathsOptions/)
})

test('main.tsx mounts on #root', () => {
  const src = fs.readFileSync(path.join(repo, 'upstream/apps/desktop/src/main.tsx'), 'utf8')
  assert.match(src, /getElementById\(['"]root['"]\)/)
})
