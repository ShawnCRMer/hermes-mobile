import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { showLoginSheet } from './login-sheet'

interface OAuthPluginInterface {
  authenticate(options: { url: string; callbackScheme: string }): Promise<{ url?: string; cancelled?: boolean }>
}

const OAuthNative = registerPlugin<OAuthPluginInterface>('OAuth')

export interface NativeTokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
  provider: string
  userId: string
}

interface PkcePair {
  verifier: string
  challenge: string
}

const TOKEN_KEY_PREFIX = 'hermes-mobile.native-tokens.'
let refreshInFlight: Promise<NativeTokenSet | null> | null = null

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomB64url(byteCount: number): string {
  const buf = new Uint8Array(byteCount)
  crypto.getRandomValues(buf)
  return b64url(buf.buffer)
}

async function generatePkcePair(): Promise<PkcePair> {
  const verifier = randomB64url(32)
  const encoded = new TextEncoder().encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', encoded)
  return { verifier, challenge: b64url(hash) }
}

function generateState(): string {
  return randomB64url(24)
}

function tokenKey(baseUrl: string): string {
  return TOKEN_KEY_PREFIX + baseUrl.replace(/\/+$/, '')
}

function tokenNeedsRefresh(tokens: NativeTokenSet, nowSeconds: number, skewSeconds = 60): boolean {
  if (!Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= 0) return true
  return nowSeconds >= tokens.expiresAt - skewSeconds
}

function parseTokenResponse(body: Record<string, unknown>): NativeTokenSet {
  const accessToken = String(body.access_token ?? '')
  if (!accessToken) throw new Error('Gateway token response missing access_token')
  const expiresAt = Number(body.expires_at)
  return {
    accessToken,
    refreshToken: String(body.refresh_token ?? ''),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    provider: String(body.provider ?? ''),
    userId: String(body.user_id ?? ''),
  }
}

function parseStoredTokenSet(body: Record<string, unknown>): NativeTokenSet {
  const accessToken = String(body.accessToken ?? '')
  if (!accessToken) throw new Error('Stored token set missing accessToken')
  const expiresAt = Number(body.expiresAt)
  return {
    accessToken,
    refreshToken: String(body.refreshToken ?? ''),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    provider: String(body.provider ?? ''),
    userId: String(body.userId ?? ''),
  }
}

let secureStorage: {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
} | null = null

async function getSecureStorage() {
  if (secureStorage) return secureStorage
  try {
    const mod = await import('@aparajita/capacitor-secure-storage')
    const ss = mod.SecureStorage
    secureStorage = {
      async get(key: string) {
        try {
          const result = await ss.getItem(key)
          return result ?? null
        } catch {
          return null
        }
      },
      async set(key: string, value: string) {
        await ss.setItem(key, value)
      },
      async remove(key: string) {
        try { await ss.removeItem(key) } catch { /* already absent */ }
      },
    }
    return secureStorage
  } catch {
    secureStorage = {
      get: (key: string) => { try { return Promise.resolve(localStorage.getItem(key)) } catch { return Promise.resolve(null) } },
      set: (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* noop */ } return Promise.resolve() },
      remove: (key: string) => { try { localStorage.removeItem(key) } catch { /* noop */ } return Promise.resolve() },
    }
    return secureStorage
  }
}

export async function loadTokens(baseUrl: string): Promise<NativeTokenSet | null> {
  const store = await getSecureStorage()
  const raw = await store.get(tokenKey(baseUrl))
  if (!raw) return null
  try {
    return parseStoredTokenSet(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function persistTokens(baseUrl: string, tokens: NativeTokenSet | null): Promise<void> {
  const store = await getSecureStorage()
  const key = tokenKey(baseUrl)
  if (!tokens) {
    await store.remove(key)
    return
  }
  await store.set(key, JSON.stringify(tokens))
}

export async function clearTokens(baseUrl: string): Promise<void> {
  await persistTokens(baseUrl, null)
}

async function nativePost(url: string, body: Record<string, unknown>): Promise<{ data: unknown; status: number }> {
  const result = await CapacitorHttp.post({
    url,
    headers: { 'Content-Type': 'application/json' },
    data: body,
    responseType: 'text',
    connectTimeout: 10_000,
    readTimeout: 10_000,
  })
  let parsed: unknown = result.data
  try { parsed = typeof result.data === 'string' ? JSON.parse(result.data) : result.data } catch { /* text */ }
  return { data: parsed, status: result.status }
}

async function nativeGet(url: string): Promise<{ data: unknown; status: number; headers: Record<string, string> }> {
  const result = await CapacitorHttp.get({
    url,
    responseType: 'text',
    connectTimeout: 10_000,
    readTimeout: 10_000,
  })
  let parsed: unknown = result.data
  try { parsed = typeof result.data === 'string' ? JSON.parse(result.data) : result.data } catch { /* text */ }
  return { data: parsed, status: result.status, headers: result.headers }
}

export async function refreshTokens(baseUrl: string, tokens: NativeTokenSet): Promise<NativeTokenSet | null> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const url = baseUrl.replace(/\/+$/, '') + '/auth/native/refresh'
      const result = await nativePost(url, {
        refresh_token: tokens.refreshToken,
        provider: tokens.provider,
      })
      if (result.status < 200 || result.status >= 300) return null
      const fresh = parseTokenResponse(result.data as Record<string, unknown>)
      await persistTokens(baseUrl, fresh)
      return fresh
    } catch {
      return null
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

export async function ensureValidTokens(baseUrl: string): Promise<NativeTokenSet | null> {
  const tokens = await loadTokens(baseUrl)
  if (!tokens) return null
  if (!tokenNeedsRefresh(tokens, Date.now() / 1000)) return tokens
  if (!tokens.refreshToken) return null
  return refreshTokens(baseUrl, tokens)
}

export async function getWsTicket(baseUrl: string, accessToken: string): Promise<string> {
  const url = baseUrl.replace(/\/+$/, '') + '/api/auth/ws-ticket'
  const result = await CapacitorHttp.post({
    url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + accessToken,
    },
    data: {},
    responseType: 'text',
    connectTimeout: 5_000,
    readTimeout: 5_000,
  })
  if (result.status < 200 || result.status >= 300) {
    throw new Error('Failed to obtain WebSocket ticket: ' + result.status)
  }
  const body = typeof result.data === 'string' ? JSON.parse(result.data) : result.data
  const ticket = (body as Record<string, unknown>).ticket
  if (typeof ticket !== 'string' || !ticket) throw new Error('ws-ticket response missing ticket field')
  return ticket
}

export async function passwordLogin(
  baseUrl: string,
  provider: string,
): Promise<NativeTokenSet | null> {
  console.log('[passwordLogin] START provider:', provider, 'baseUrl:', baseUrl)
  const normalized = baseUrl.replace(/\/+$/, '')
  const pkce = await generatePkcePair()
  const state = generateState()
  const redirectUri = 'http://127.0.0.1:1/hermes-mobile'

  const authorizeUrl =
    normalized + '/auth/native/authorize?' +
    new URLSearchParams({
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      redirect_uri: redirectUri,
      state,
      provider,
    }).toString()

  console.log('[passwordLogin] Step 1: hitting authorize URL:', authorizeUrl)
  const authorizeResult = await nativeGet(authorizeUrl)
  console.log('[passwordLogin] Step 1 result: status=', authorizeResult.status, 'headers=', JSON.stringify(authorizeResult.headers))

  console.log('[passwordLogin] showing login sheet...')
  return new Promise<NativeTokenSet | null>((resolve) => {
    const sheet = showLoginSheet(normalized, async ({ username, password }) => {
      console.log('[passwordLogin] form submitted, username:', username)
      sheet.setLoading(true)
      try {
        console.log('[passwordLogin] Step 2: POST /auth/password-login')
        const loginResult = await nativePost(normalized + '/auth/password-login', {
          provider,
          username,
          password,
          next: '',
        })
        console.log('[passwordLogin] Step 2 result: status=', loginResult.status, 'data=', JSON.stringify(loginResult.data))

        if (loginResult.status < 200 || loginResult.status >= 300) {
          const msg = loginResult.status === 401 || loginResult.status === 403
            ? 'Invalid username or password'
            : 'Login failed (' + loginResult.status + ')'
          console.error('[passwordLogin] Step 2 FAILED:', msg)
          sheet.setError(msg)
          return
        }

        const loginBody = loginResult.data as Record<string, unknown>
        if (!loginBody.ok) {
          console.error('[passwordLogin] loginBody.ok is falsy:', loginBody)
          sheet.setError(String(loginBody.error ?? 'Login failed'))
          return
        }

        const nextUrl = String(loginBody.next ?? '')
        console.log('[passwordLogin] next URL:', nextUrl)
        if (!nextUrl || !nextUrl.includes('code=')) {
          console.error('[passwordLogin] no code= in next URL')
          sheet.setError('Gateway did not return an authorization code')
          return
        }

        const callbackUrl = new URL(nextUrl, 'http://127.0.0.1')
        const code = callbackUrl.searchParams.get('code')
        const returnedState = callbackUrl.searchParams.get('state')
        console.log('[passwordLogin] Step 3: code=', code ? 'present' : 'MISSING', 'state match=', returnedState === state)

        if (!code) {
          sheet.setError('Authorization code missing from response')
          return
        }
        if (returnedState !== state) {
          console.error('[passwordLogin] state mismatch: expected=', state, 'got=', returnedState)
          sheet.setError('State mismatch — possible CSRF attack')
          return
        }

        console.log('[passwordLogin] Step 4: exchanging code for tokens...')
        const tokenResult = await nativePost(normalized + '/auth/native/token', {
          code,
          code_verifier: pkce.verifier,
        })
        console.log('[passwordLogin] Step 4 result: status=', tokenResult.status)

        if (tokenResult.status < 200 || tokenResult.status >= 300) {
          console.error('[passwordLogin] token exchange failed:', tokenResult.status, tokenResult.data)
          sheet.setError('Token exchange failed (' + tokenResult.status + ')')
          return
        }

        const tokens = parseTokenResponse(tokenResult.data as Record<string, unknown>)
        await persistTokens(normalized, tokens)
        console.log('[passwordLogin] SUCCESS — tokens persisted')

        sheet.dismiss()
        resolve(tokens)
      } catch (err) {
        console.error('[passwordLogin] EXCEPTION:', err)
        sheet.setError(err instanceof Error ? err.message : 'An error occurred')
      }
    })

    sheet.cancelled.then(() => {
      console.log('[passwordLogin] user CANCELLED')
      resolve(null)
    })
  })
}

export async function oauthBrowserLogin(
  baseUrl: string,
  provider?: string,
): Promise<NativeTokenSet | null> {
  console.log('[oauthBrowser] START provider:', provider, 'baseUrl:', baseUrl)
  if (!Capacitor.isNativePlatform()) {
    console.log('[oauthBrowser] NOT native platform, returning null')
    return null
  }

  const normalized = baseUrl.replace(/\/+$/, '')
  const pkce = await generatePkcePair()
  const state = generateState()
  const callbackScheme = 'hermes'

  const params: Record<string, string> = {
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
  }
  if (provider) params.provider = provider

  const authorizeUrl =
    normalized + '/auth/native/authorize?' +
    new URLSearchParams(params).toString()

  console.log('[oauthBrowser] calling OAuthNative.authenticate with URL:', authorizeUrl)
  const result = await OAuthNative.authenticate({
    url: authorizeUrl,
    callbackScheme,
  })
  console.log('[oauthBrowser] authenticate result:', JSON.stringify(result))

  if (result.cancelled || !result.url) {
    console.log('[oauthBrowser] cancelled or no URL, returning null')
    return null
  }

  const callbackUrl = new URL(result.url)
  const code = callbackUrl.searchParams.get('code')
  const returnedState = callbackUrl.searchParams.get('state')
  console.log('[oauthBrowser] code:', code ? 'present' : 'MISSING', 'state match:', returnedState === state)

  if (!code) throw new Error('Authorization code missing from callback')
  if (returnedState !== state) throw new Error('State mismatch — possible CSRF')

  console.log('[oauthBrowser] exchanging code for tokens...')
  const tokenResult = await nativePost(normalized + '/auth/native/token', {
    code,
    code_verifier: pkce.verifier,
  })
  console.log('[oauthBrowser] token exchange status:', tokenResult.status)

  if (tokenResult.status < 200 || tokenResult.status >= 300) {
    throw new Error('Token exchange failed (' + tokenResult.status + ')')
  }

  const tokens = parseTokenResponse(tokenResult.data as Record<string, unknown>)
  await persistTokens(normalized, tokens)
  console.log('[oauthBrowser] SUCCESS — tokens persisted')
  return tokens
}
