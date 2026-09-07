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

test('every manifest method has a valid status', () => {
  const validStatuses = new Set(['impl', 'stub', 'omit'])
  for (const [method, status] of Object.entries(manifest.methods)) {
    assert.ok(validStatuses.has(status), `${method} has invalid status: ${status}`)
  }
})

test('Phase 1 methods are implemented (not stub)', () => {
  const phase1Methods = [
    'oauthLoginConnectionConfig',
    'oauthLogoutConnectionConfig',
    'notify',
    'saveClipboardImage',
    'saveGatewayFile',
    'onNotificationAction',
    'onNotificationActivate',
  ]
  for (const method of phase1Methods) {
    assert.equal(manifest.methods[method], 'impl', `${method} should be impl after Phase 1`)
  }
})

test('core transport methods are implemented', () => {
  const coreTransport = [
    'getConnection', 'getConnectionFor', 'getGatewayWsUrl', 'getGatewayWsUrlFor',
    'api', 'revalidateConnection', 'getConnectionConfig', 'saveConnectionConfig',
    'applyConnectionConfig', 'testConnectionConfig', 'probeConnectionConfig',
    'connections', 'profile', 'getVersion', 'getBootProgress', 'onBootProgress',
    'onPowerResume',
  ]
  for (const method of coreTransport) {
    assert.equal(manifest.methods[method], 'impl', `${method} must be impl`)
  }
})

test('no required method is omitted', () => {
  const block = contract.match(/interface Window[\s\S]*?hermesDesktop:\s*\{([\s\S]*?)^    \}\s*^  \}/m)?.[1] ?? ''
  const required = [...block.matchAll(/^      ([A-Za-z_$][A-Za-z0-9_$]*):/gm)].map(match => match[1])
  const omitted = required.filter(name => manifest.methods[name] === 'omit')
  assert.deepEqual(omitted, [], 'Required methods must not be omitted — only optional methods may be omitted')
})

test('bridge source exports satisfies Window[hermesDesktop]', () => {
  const bridgeSrc = fs.readFileSync(path.join(repo, 'src/bridge/index.ts'), 'utf8')
  assert.match(bridgeSrc, /satisfies Window\['hermesDesktop'\]/)
})

test('bridge source imports auth module', () => {
  const bridgeSrc = fs.readFileSync(path.join(repo, 'src/bridge/index.ts'), 'utf8')
  assert.match(bridgeSrc, /from ['"]\.\/auth['"]/)
})

test('bridge source imports edge-swipe module', () => {
  const bridgeSrc = fs.readFileSync(path.join(repo, 'src/bridge/index.ts'), 'utf8')
  assert.match(bridgeSrc, /from ['"]\.\/edge-swipe['"]/)
})

test('auth module exports required functions', () => {
  const authSrc = fs.readFileSync(path.join(repo, 'src/bridge/auth.ts'), 'utf8')
  assert.match(authSrc, /export async function passwordLogin/)
  assert.match(authSrc, /export async function ensureValidTokens/)
  assert.match(authSrc, /export async function clearTokens/)
  assert.match(authSrc, /export async function getWsTicket/)
  assert.match(authSrc, /export async function refreshTokens/)
  assert.match(authSrc, /export async function loadTokens/)
})

test('mobile.css is scoped under data-hermes-host=mobile', () => {
  const css = fs.readFileSync(path.join(repo, 'src/styles/mobile.css'), 'utf8')
  const rules = css.match(/html\[data-hermes-host='mobile'\]/g) ?? []
  assert.ok(rules.length > 10, `Expected 10+ scoped rules, found ${rules.length}`)
  assert.ok(!css.includes('html {'), 'mobile.css must not have unscoped html rules')
})
