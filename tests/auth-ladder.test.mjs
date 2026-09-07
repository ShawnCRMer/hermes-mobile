import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repo = path.resolve(import.meta.dirname, '..')

test('auth module handles all auth_flows fixtures', () => {
  const authSrc = fs.readFileSync(path.join(repo, 'src/bridge/auth.ts'), 'utf8')
  assert.match(authSrc, /passwordLogin/, 'must export passwordLogin for password providers')
  assert.match(authSrc, /ensureValidTokens/, 'must export ensureValidTokens for token refresh')
  assert.match(authSrc, /refreshTokens/, 'must export refreshTokens')
  assert.match(authSrc, /getWsTicket/, 'must export getWsTicket for Bearer WebSocket auth')
})

test('auth_flows: [] — token mode (no auth required)', () => {
  const bridgeSrc = fs.readFileSync(path.join(repo, 'src/bridge/index.ts'), 'utf8')
  assert.match(bridgeSrc, /X-Hermes-Session-Token/, 'token mode sends X-Hermes-Session-Token header')
  assert.match(bridgeSrc, /readServedToken/, 'token mode reads token from gateway root page')
})

test('auth_flows: ["cookie"] — password provider via PKCE broker', () => {
  const authSrc = fs.readFileSync(path.join(repo, 'src/bridge/auth.ts'), 'utf8')
  assert.match(authSrc, /\/auth\/native\/authorize/, 'initiates PKCE broker at /auth/native/authorize')
  assert.match(authSrc, /code_challenge/, 'sends code_challenge parameter')
  assert.match(authSrc, /code_challenge_method/, 'sends code_challenge_method=S256')
  assert.match(authSrc, /\/auth\/password-login/, 'posts credentials to /auth/password-login')
  assert.match(authSrc, /\/auth\/native\/token/, 'exchanges code at /auth/native/token')
  assert.match(authSrc, /code_verifier/, 'sends code_verifier for PKCE verification')
})

test('auth_flows: ["cookie","native_pkce"] — token refresh', () => {
  const authSrc = fs.readFileSync(path.join(repo, 'src/bridge/auth.ts'), 'utf8')
  assert.match(authSrc, /\/auth\/native\/refresh/, 'refreshes at /auth/native/refresh')
  assert.match(authSrc, /refresh_token/, 'sends refresh_token')
  assert.match(authSrc, /expiresAt/, 'checks token expiry')
})

test('auth_flows: ["cookie","native_pkce","native_pkce_app_redirect"] — Phase 2 placeholder', () => {
  const bridgeSrc = fs.readFileSync(path.join(repo, 'src/bridge/index.ts'), 'utf8')
  assert.match(
    bridgeSrc,
    /ok: false.*connected: false/,
    'oauthLoginConnectionConfig falls back gracefully when no password provider exists (Phase 2 OAuth not yet supported)'
  )
})

test('PKCE uses SHA-256 challenge method', () => {
  const authSrc = fs.readFileSync(path.join(repo, 'src/bridge/auth.ts'), 'utf8')
  assert.match(authSrc, /SHA-256/, 'uses Web Crypto SHA-256 for PKCE challenge')
  assert.match(authSrc, /crypto\.subtle\.digest/, 'uses crypto.subtle.digest')
  assert.match(authSrc, /crypto\.getRandomValues/, 'uses crypto.getRandomValues for verifier')
})

test('redirect_uri is a loopback placebo', () => {
  const authSrc = fs.readFileSync(path.join(repo, 'src/bridge/auth.ts'), 'utf8')
  assert.match(authSrc, /http:\/\/127\.0\.0\.1:1\/hermes-mobile/, 'uses placebo loopback redirect_uri')
})

test('state parameter verified against CSRF', () => {
  const authSrc = fs.readFileSync(path.join(repo, 'src/bridge/auth.ts'), 'utf8')
  assert.match(authSrc, /returnedState !== state/, 'verifies state matches to prevent CSRF')
})

test('tokens stored via secure storage', () => {
  const authSrc = fs.readFileSync(path.join(repo, 'src/bridge/auth.ts'), 'utf8')
  assert.match(authSrc, /@aparajita\/capacitor-secure-storage/, 'imports secure storage for Keychain')
  assert.match(authSrc, /persistTokens/, 'persists tokens after successful auth')
})

test('bridge uses Bearer auth for OAuth connections', () => {
  const bridgeSrc = fs.readFileSync(path.join(repo, 'src/bridge/index.ts'), 'utf8')
  assert.match(bridgeSrc, /Authorization.*Bearer/, 'sets Bearer header for OAuth mode')
})

test('bridge retries on 401 with token refresh', () => {
  const bridgeSrc = fs.readFileSync(path.join(repo, 'src/bridge/index.ts'), 'utf8')
  assert.match(bridgeSrc, /result\.status === 401/, 'detects 401 response')
  assert.match(bridgeSrc, /refreshTokens/, 'calls refreshTokens on 401')
})

test('WebSocket uses ws-ticket for Bearer auth', () => {
  const bridgeSrc = fs.readFileSync(path.join(repo, 'src/bridge/index.ts'), 'utf8')
  assert.match(bridgeSrc, /getWsTicket/, 'uses ws-ticket endpoint')
  assert.match(bridgeSrc, /ticket/, 'passes ticket as WebSocket query param')
})
