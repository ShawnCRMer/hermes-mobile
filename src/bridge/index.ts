import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { LocalNotifications } from '@capacitor/local-notifications'
import { Share } from '@capacitor/share'
import { ensureValidTokens, clearTokens, passwordLogin, getWsTicket, loadTokens, refreshTokens } from './auth'
import { installEdgeSwipe } from './edge-swipe'
import { getNativeHapticTrigger, hapticTick } from './haptics'
import { onDeepLink, signalDeepLinkReady, initDeepLinkListener } from './deep-link'
import { getOnBattery, onBatteryChanged } from './battery'
import { initNetworkMonitor } from './network'
import { searchMarketplace, fetchMarketplace } from './vscode-marketplace'
import { StatusBar, Style } from '@capacitor/status-bar'
import type {
  DesktopAuthProvider,
  DesktopBootProgress,
  DesktopBootstrapState,
  DesktopConnectionConfig,
  DesktopConnectionConfigInput,
  DesktopConnectionsRegistry,
  DesktopRegistryConnection,
  DesktopRegistryConnectionInput,
  DesktopRosterAgent,
  HermesApiRequest,
  HermesConnection,
  HermesSelectPathsOptions,
} from '@/global'

const CONNECTION_KEY = 'hermes-mobile.connection.v1'
const REGISTRY_KEY = 'hermes-mobile.connections.v2'
const PROFILE_KEY = 'hermes-mobile.profile'
const UPSTREAM_SHA = 'f159e581c7afd22a5c94652c569e3859f1b994d2'
const MAX_FILE_BYTES = 25 * 1024 * 1024
const DEFAULT_POOL_LIMITS = { maxBackends: 1, idleMs: 60_000 }

type StoredConnection = {
  id: string
  label: string
  url: string
  token: string
  authMode: 'oauth' | 'token'
  kind: 'cloud' | 'remote'
}

type HttpResult = { data: unknown; headers: Record<string, string>; status: number }

const inflightRequests = new Map<string, Promise<unknown>>()

function dedupeKey(method: string, path: string, body: unknown): string {
  return method + '\0' + path + '\0' + (body !== undefined ? JSON.stringify(body) : '')
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

let notificationId = 1
let notificationPermissionGranted: boolean | null = null
type NotificationActionCallback = (payload: { actionId: string; sessionId?: string }) => void
type NotificationActivateCallback = (payload: { actionId?: string; activate?: string; notifyId?: string; tag?: string }) => void
const notificationActionListeners = new Set<NotificationActionCallback>()
const notificationActivateListeners = new Set<NotificationActivateCallback>()

async function ensureNotificationPermission(): Promise<boolean> {
  if (notificationPermissionGranted === true) return true
  try {
    const result = await LocalNotifications.requestPermissions()
    notificationPermissionGranted = result.display === 'granted'
    return notificationPermissionGranted
  } catch {
    return false
  }
}

function initNotificationListeners(): void {
  LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
    const data = (event.notification.extra ?? {}) as Record<string, string | undefined>
    for (const cb of notificationActionListeners) {
      cb({ actionId: event.actionId, sessionId: data.sessionId })
    }
    for (const cb of notificationActivateListeners) {
      cb({ actionId: event.actionId, activate: data.activate, notifyId: data.notifyId, tag: data.tag })
    }
  })
}

const noOp = () => undefined
const noOpUnsubscribe = () => noOp

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private browsing can reject storage; the in-memory session still works.
  }
}

let memoryConnection: StoredConnection | null = null
let memoryRegistry: DesktopConnectionsRegistry | null = null

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function runtimeConfig(): HermesMobileRuntimeConfig {
  return window.__HERMES_MOBILE_CONFIG__ ?? {}
}

function defaultBaseUrl(): string {
  if (!Capacitor.isNativePlatform()) {
    return normalizeBaseUrl(window.location.origin)
  }
  const queryUrl = new URLSearchParams(window.location.search).get('gateway')
  return normalizeBaseUrl(
    queryUrl || runtimeConfig().gatewayUrl || import.meta.env.VITE_HERMES_GATEWAY_URL || 'http://127.0.0.1:9119',
  )
}

function configuredToken(): string {
  const queryToken = new URLSearchParams(window.location.search).get('token')
  return queryToken || runtimeConfig().token || import.meta.env.VITE_HERMES_SESSION_TOKEN || ''
}

function readConnection(): StoredConnection {
  if (memoryConnection) return memoryConnection
  try {
    const parsed = JSON.parse(readStorage(CONNECTION_KEY) ?? 'null') as Partial<StoredConnection> | null
    if (parsed?.url && typeof parsed.url === 'string') {
      memoryConnection = {
        id: parsed.id || 'gateway',
        label: parsed.label || 'Gateway',
        url: normalizeBaseUrl(parsed.url),
        token: typeof parsed.token === 'string' ? parsed.token : '',
        authMode: parsed.authMode === 'oauth' ? 'oauth' : 'token',
        kind: parsed.kind === 'cloud' ? 'cloud' : 'remote',
      }
      return memoryConnection
    }
  } catch {
    // Recreate a healthy default below.
  }
  memoryConnection = {
    id: 'gateway',
    label: 'Gateway',
    url: defaultBaseUrl(),
    token: configuredToken(),
    authMode: 'token',
    kind: 'remote',
  }
  return memoryConnection
}

function persistConnection(connection: StoredConnection): void {
  memoryConnection = connection
  writeStorage(CONNECTION_KEY, JSON.stringify(connection))
}

async function readServedToken(baseUrl: string): Promise<string> {
  let html: string
  if (Capacitor.isNativePlatform()) {
    const result = await CapacitorHttp.get({
      url: baseUrl + '/',
      responseType: 'text',
      connectTimeout: 3_000,
      readTimeout: 3_000,
    })
    if (result.status < 200 || result.status >= 300) throw new Error(String(result.status))
    html = typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
  } else {
    const response = await fetch(baseUrl + '/', { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) throw new Error(String(response.status) + ': ' + (await response.text()))
    html = await response.text()
  }
  const match = /window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:\\.|[^"\\])*")/.exec(html)
  if (!match) return ''
  try {
    return JSON.parse(match[1]) as string
  } catch {
    return ''
  }
}

async function resolveConnection(connectionId?: string | null): Promise<StoredConnection> {
  const connection = readConnection()
  if (!connectionId || connectionId === connection.id) {
    if (!connection.token) {
      try {
        const token = await readServedToken(connection.url)
        if (token) {
          const refreshed = { ...connection, token }
          persistConnection(refreshed)
          return refreshed
        }
      } catch {
        // The API request produces the useful connection error.
      }
    }
    return connection
  }
  const registry = await listRegistry()
  const entry = registry.connections.find(item => item.id === connectionId)
  if (!entry?.url) throw new Error('Unknown Hermes connection: ' + connectionId)
  return {
    id: entry.id,
    label: entry.label,
    url: normalizeBaseUrl(entry.url),
    token: readStorage('hermes-mobile.token.' + entry.id) ?? '',
    authMode: entry.authMode === 'oauth' ? 'oauth' : 'token',
    kind: entry.kind === 'cloud' ? 'cloud' : 'remote',
  }
}

function websocketUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl + '/api/ws')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (token) url.searchParams.set('token', token)
  return url.toString()
}

async function resolveWsUrl(connection: StoredConnection): Promise<string> {
  if (connection.authMode === 'oauth') {
    const tokens = await ensureValidTokens(connection.url)
    if (tokens) {
      const ticket = await getWsTicket(connection.url, tokens.accessToken)
      const url = new URL(connection.url + '/api/ws')
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('ticket', ticket)
      return url.toString()
    }
  }
  return websocketUrl(connection.url, connection.token)
}

function connectionDescriptor(connection: StoredConnection): HermesConnection {
  return {
    baseUrl: connection.url,
    isFullscreen: false,
    mode: 'remote',
    authMode: connection.authMode,
    nativeOverlayWidth: 0,
    remoteKind: connection.kind === 'cloud' ? 'cloud' : 'url',
    source: 'settings',
    token: connection.token,
    wsUrl: websocketUrl(connection.url, connection.token),
    logs: [],
    windowButtonPosition: null,
    connectionId: connection.id,
    registryScoped: true,
  }
}

function apiUrl(baseUrl: string, input: HermesApiRequest): string {
  const url = new URL(input.path, baseUrl + '/')
  if (input.profile) url.searchParams.set('profile', input.profile)
  return url.toString()
}

async function browserRequest(
  url: string,
  input: HermesApiRequest,
  headers: Record<string, string>,
): Promise<HttpResult> {
  const controller = new AbortController()
  const timeout = input.timeoutMs ? setTimeout(() => controller.abort(), input.timeoutMs) : undefined
  try {
    const init: RequestInit = { method: input.method ?? 'GET', headers, signal: controller.signal }
    if (input.upload) {
      const form = new FormData()
      form.append(
        'file',
        new Blob([input.upload.bytes], { type: input.upload.contentType ?? 'application/octet-stream' }),
        input.upload.filename,
      )
      init.body = form
    } else if (input.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(input.body)
    }
    const response = await fetch(url, init)
    return {
      data: await response.text(),
      headers: Object.fromEntries(response.headers.entries()),
      status: response.status,
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function nativeRequest(
  url: string,
  input: HermesApiRequest,
  headers: Record<string, string>,
): Promise<HttpResult> {
  if (input.upload) throw new Error('Multipart uploads are not available in the Phase 0 mobile bridge.')
  const response = await CapacitorHttp.request({
    url,
    method: input.method ?? 'GET',
    headers,
    data: input.body,
    responseType: 'text',
    connectTimeout: input.timeoutMs,
    readTimeout: input.timeoutMs,
  })
  return { data: response.data, headers: response.headers, status: response.status }
}

async function applyAuth(connection: StoredConnection, headers: Record<string, string>): Promise<void> {
  if (connection.authMode === 'oauth') {
    const tokens = await ensureValidTokens(connection.url)
    if (tokens) {
      headers.Authorization = 'Bearer ' + tokens.accessToken
      return
    }
  }
  if (connection.token) {
    headers['X-Hermes-Session-Token'] = connection.token
  }
}

async function executeRequest(connection: StoredConnection, input: HermesApiRequest): Promise<unknown> {
  const headers: Record<string, string> = {}
  await applyAuth(connection, headers)
  const url = apiUrl(connection.url, input)
  const result = Capacitor.isNativePlatform()
    ? await nativeRequest(url, input, headers)
    : await browserRequest(url, input, headers)
  const raw = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '')
  let parsed: unknown = raw
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    // Preserve non-JSON responses as text.
  }
  if (result.status === 401 && connection.authMode === 'oauth') {
    const tokens = await loadTokens(connection.url)
    if (tokens?.refreshToken) {
      const fresh = await refreshTokens(connection.url, tokens)
      if (fresh) {
        const retryHeaders: Record<string, string> = { Authorization: 'Bearer ' + fresh.accessToken }
        const retry = Capacitor.isNativePlatform()
          ? await nativeRequest(url, input, retryHeaders)
          : await browserRequest(url, input, retryHeaders)
        const retryRaw = typeof retry.data === 'string' ? retry.data : JSON.stringify(retry.data ?? '')
        let retryParsed: unknown = retryRaw
        try { retryParsed = retryRaw ? JSON.parse(retryRaw) : null } catch { /* text */ }
        if (retry.status >= 200 && retry.status < 300) return retryParsed
      }
    }
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(String(result.status) + ': ' + (typeof parsed === 'string' ? parsed : JSON.stringify(parsed)))
  }
  return parsed
}

async function request(connection: StoredConnection, input: HermesApiRequest): Promise<unknown> {
  const method = input.method ?? 'GET'
  if (method === 'GET' && !input.upload) {
    const key = dedupeKey(method, apiUrl(connection.url, input), input.body)
    const existing = inflightRequests.get(key)
    if (existing) return existing
    const promise = executeRequest(connection, input).finally(() => inflightRequests.delete(key))
    inflightRequests.set(key, promise)
    return promise
  }
  return executeRequest(connection, input)
}

function tokenPreview(token: string): string | null {
  return token ? token.slice(0, 4) + '…' : null
}

function registryFromConnection(connection: StoredConnection): DesktopConnectionsRegistry {
  return {
    version: 2,
    primary: connection.id,
    launchMode: 'primary',
    lastUsed: connection.id,
    secureTokenStorage: true,
    connections: [{
      id: connection.id,
      kind: connection.kind,
      label: connection.label,
      url: connection.url,
      authMode: connection.authMode,
      tokenSet: Boolean(connection.token),
      tokenPreview: tokenPreview(connection.token),
    }],
  }
}

async function listRegistry(): Promise<DesktopConnectionsRegistry> {
  if (memoryRegistry) return memoryRegistry
  try {
    const parsed = JSON.parse(readStorage(REGISTRY_KEY) ?? 'null') as DesktopConnectionsRegistry | null
    if (parsed?.version === 2 && Array.isArray(parsed.connections)) {
      memoryRegistry = parsed
      return parsed
    }
  } catch {
    // Recreate the single-entry registry.
  }
  const registry = registryFromConnection(readConnection())
  memoryRegistry = registry
  writeStorage(REGISTRY_KEY, JSON.stringify(registry))
  return registry
}

function persistRegistry(registry: DesktopConnectionsRegistry): void {
  memoryRegistry = registry
  writeStorage(REGISTRY_KEY, JSON.stringify(registry))
}

function bootProgress(): DesktopBootProgress {
  return {
    running: false,
    progress: 100,
    phase: 'ready',
    error: null,
    fakeMode: false,
    message: '',
    timestamp: Date.now(),
  }
}

function emptyBootstrapState(): DesktopBootstrapState {
  return {
    active: false,
    manifest: null,
    stages: {},
    error: null,
    log: [],
    startedAt: null,
    completedAt: null,
    setupChoice: null,
    unsupportedPlatform: null,
  }
}

function unsupportedError(): never {
  throw new Error('unsupported')
}

async function chooseFiles(options?: HermesSelectPathsOptions): Promise<string[]> {
  if (options?.directories) return []
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options?.multiple !== false
    if (options?.filters?.length) {
      input.accept = options.filters.flatMap(item => item.extensions.map(ext => '.' + ext)).join(',')
    }
    input.onchange = () => resolve(Array.from(input.files ?? [], file => URL.createObjectURL(file)))
    input.click()
  })
}

export const bridge = {
  async getConnection(profile?: string | null) {
    const connection = await resolveConnection()
    const desc = connectionDescriptor(connection)
    if (connection.authMode === 'oauth') {
      const tokens = await ensureValidTokens(connection.url)
      if (tokens) desc.token = tokens.accessToken
    }
    return { ...desc, ...(profile ? { profile } : {}) }
  },
  async getConnectionFor(payload: { connectionId?: null | string; profile?: null | string }) {
    const connection = await resolveConnection(payload.connectionId)
    const desc = connectionDescriptor(connection)
    if (connection.authMode === 'oauth') {
      const tokens = await ensureValidTokens(connection.url)
      if (tokens) desc.token = tokens.accessToken
    }
    return { ...desc, ...(payload.profile ? { profile: payload.profile } : {}) }
  },
  async getGatewayWsUrl(profile?: null | string) {
    const connection = await resolveConnection()
    const wsUrl = await resolveWsUrl(connection)
    return { ok: true as const, wsUrl, ...(profile ? { profile } : {}) }
  },
  async getGatewayWsUrlFor(payload: { connectionId?: null | string; profile?: null | string }) {
    const connection = await resolveConnection(payload.connectionId)
    const wsUrl = await resolveWsUrl(connection)
    return { ok: true as const, wsUrl }
  },
  async getProfileRoutes() {
    return []
  },
  async revalidateConnection() {
    try {
      await request(await resolveConnection(), { path: '/api/status' })
      return { ok: true, rebuilt: false }
    } catch {
      return { ok: false, rebuilt: false }
    }
  },
  async touchBackend() { return { ok: true } },
  async getPoolLimits() { return { ...DEFAULT_POOL_LIMITS } },
  async setPoolLimits() { return { ok: true, limits: { ...DEFAULT_POOL_LIMITS } } },
  async openSessionWindow() { return { ok: false, error: 'unsupported' } },
  async openSessionInTerminal() { return { ok: false, error: 'unsupported' } },
  async openWindow() { return { ok: false, error: 'unsupported' } },
  async openBrowserWindow() { return { ok: false, error: 'unsupported' } },
  onBrowserPopoutClosed: noOpUnsubscribe,
  async claimAmbientCue() { return true },
  petOverlay: {
    async open() { return { ok: false } },
    async close() { return { ok: true } },
    setBounds: noOp, setIgnoreMouse: noOp, setFocusable: noOp, pushState: noOp, control: noOp,
    onState: noOpUnsubscribe, onControl: noOpUnsubscribe,
  },
  quickEntry: {
    async getSettings() { return { enabled: false, error: null, registered: false, shortcut: '' } },
    async setSettings() { return { enabled: false, error: null, registered: false, shortcut: '' } },
    submit: noOp, dismiss: noOp, pushState: noOp,
    onState: noOpUnsubscribe, onSubmit: noOpUnsubscribe, onShown: noOpUnsubscribe,
  },
  getBootProgress: async () => bootProgress(),
  async getConnectionConfig(_profile?: null | string): Promise<DesktopConnectionConfig> {
    const connection = readConnection()
    const oauthConnected = connection.authMode === 'oauth' && Boolean(await loadTokens(connection.url))
    return {
      envOverride: false, mode: 'remote', profile: null, remoteAuthMode: connection.authMode,
      remoteOauthConnected: oauthConnected, remoteTokenPreview: tokenPreview(connection.token),
      remoteTokenSet: Boolean(connection.token), secureTokenStorage: true, remoteTokenPlainText: false,
      remoteUrl: connection.url, cloudOrg: '', sshHost: '', sshUser: '', sshPort: null,
      sshKeyPath: '', sshRemoteHermesPath: '', sshRemoteProfile: '',
    }
  },
  async saveConnectionConfig(payload: DesktopConnectionConfigInput): Promise<DesktopConnectionConfig> {
    if (payload.mode !== 'remote' && payload.mode !== 'cloud') {
      throw new Error('Only remote and cloud connections are supported on mobile.')
    }
    const previous = readConnection()
    const connection: StoredConnection = {
      id: previous.id, label: previous.label, url: normalizeBaseUrl(payload.remoteUrl ?? previous.url),
      token: payload.remoteToken ?? previous.token, authMode: payload.remoteAuthMode ?? previous.authMode,
      kind: payload.mode === 'cloud' ? 'cloud' : 'remote',
    }
    persistConnection(connection)
    persistRegistry(registryFromConnection(connection))
    return bridge.getConnectionConfig()
  },
  async applyConnectionConfig(payload: DesktopConnectionConfigInput): Promise<DesktopConnectionConfig> {
    return bridge.saveConnectionConfig(payload)
  },
  async testConnectionConfig(payload: DesktopConnectionConfigInput) {
    const baseUrl = normalizeBaseUrl(payload.remoteUrl ?? readConnection().url)
    const connection = { ...readConnection(), url: baseUrl, token: payload.remoteToken ?? readConnection().token }
    try {
      const result = (await request(connection, { path: '/api/status', timeoutMs: 5_000 })) as Record<string, unknown>
      return { ok: true, reachable: true, baseUrl, version: typeof result.version === 'string' ? result.version : null }
    } catch (error) {
      return { ok: false, reachable: false, baseUrl, error: String(error), version: null }
    }
  },
  getSecretStorageEncryption: async () => ({ on: true }),
  setSecretStorageEncryption: async () => ({ on: true }),
  connections: {
    list: listRegistry,
    async save(payload: DesktopRegistryConnectionInput) {
      if (payload.kind !== 'remote' && payload.kind !== 'cloud') {
        throw new Error('Only remote and cloud connections are supported on mobile.')
      }
      const current = await listRegistry()
      const id = payload.id ?? 'connection-' + Date.now()
      const token = payload.token ?? ''
      if (token) writeStorage('hermes-mobile.token.' + id, token)
      const old = current.connections.find(item => item.id === id)
      const entry: DesktopRegistryConnection = {
        id, kind: payload.kind, label: payload.label, url: payload.url,
        authMode: payload.authMode ?? 'token', tokenSet: Boolean(token) || old?.tokenSet === true,
        tokenPreview: tokenPreview(token),
      }
      const registry = { ...current, connections: [...current.connections.filter(item => item.id !== id), entry] }
      persistRegistry(registry)
      return { ok: true, connection: entry, registry }
    },
    async remove(id: string) {
      const current = await listRegistry()
      if (id === current.primary) return { ok: false, registry: current }
      const registry = { ...current, connections: current.connections.filter(item => item.id !== id) }
      persistRegistry(registry)
      return { ok: true, registry }
    },
    async setPrimary(id: string) {
      const current = await listRegistry()
      if (!current.connections.some(item => item.id === id)) return { ok: false, registry: current }
      const registry = { ...current, primary: id }
      persistRegistry(registry)
      return { ok: true, registry }
    },
    async setLaunchMode(mode: 'last-used' | 'primary') {
      const registry = { ...(await listRegistry()), launchMode: mode }
      persistRegistry(registry)
      return { ok: true, registry }
    },
    async setLastUsed(id: string) {
      const registry = { ...(await listRegistry()), lastUsed: id }
      persistRegistry(registry)
      return { ok: true, registry }
    },
    async test(id: string): Promise<{ ok?: boolean; reachable?: boolean; baseUrl?: string; error?: string | null; version?: string | null }> {
      const entry = (await listRegistry()).connections.find((item: DesktopRegistryConnection) => item.id === id)
      return bridge.testConnectionConfig({ mode: 'remote', remoteUrl: entry?.url })
    },
    onChanged: noOpUnsubscribe,
  },
  async getAgentRoster() {
    const registry = await listRegistry()
    const agents: DesktopRosterAgent[] = []
    const sources = await Promise.all(registry.connections.map(async entry => {
      try {
        const response = (await request(await resolveConnection(entry.id), { path: '/api/profiles' })) as unknown
        const profiles = Array.isArray(response) ? response :
          Array.isArray((response as { profiles?: unknown[] })?.profiles) ? (response as { profiles: unknown[] }).profiles : []
        for (const item of profiles) {
          const profile = typeof item === 'string' ? item : String((item as { name?: unknown })?.name ?? '')
          if (profile) agents.push({
            connectionId: entry.id, connectionKind: entry.kind, connectionLabel: entry.label,
            profile, handle: '@' + profile + '-' + entry.label,
          })
        }
        return { connectionId: entry.id, label: entry.label, kind: entry.kind, reachable: true }
      } catch (error) {
        return { connectionId: entry.id, label: entry.label, kind: entry.kind, reachable: false, error: String(error) }
      }
    }))
    return { agents, sources }
  },
  async sshConfigHosts() { return { hosts: [] } },
  async sshResolveHost() { return { hostname: null, identityFile: null, port: null, user: null } },
  async probeConnectionConfig(remoteUrl: string) {
    const baseUrl = normalizeBaseUrl(remoteUrl)
    try {
      const connection = { ...readConnection(), url: baseUrl }
      const status = (await request(connection, { path: '/api/status', timeoutMs: 5_000 })) as Record<string, unknown>
      let providers: DesktopAuthProvider[] = []
      try { providers = (await request(connection, { path: '/api/auth/providers', timeoutMs: 5_000 })) as DesktopAuthProvider[] } catch { /* optional */ }
      return {
        baseUrl, reachable: true, authMode: status.auth_required ? 'oauth' as const : 'token' as const,
        providers, version: typeof status.version === 'string' ? status.version : null, error: null,
      }
    } catch (error) {
      return { baseUrl, reachable: false, authMode: 'unknown' as const, providers: [], version: null, error: String(error) }
    }
  },
  async oauthLoginConnectionConfig(remoteUrl: string) {
    const baseUrl = normalizeBaseUrl(remoteUrl)
    try {
      const probe = await bridge.probeConnectionConfig(baseUrl)
      const provider = probe.providers?.find((p: DesktopAuthProvider) => p.supportsPassword)
      if (!provider) {
        return { ok: false, baseUrl, connected: false }
      }
      const tokens = await passwordLogin(baseUrl, provider.name)
      if (!tokens) return { ok: false, baseUrl, connected: false }
      const connection = readConnection()
      if (normalizeBaseUrl(connection.url) === baseUrl) {
        persistConnection({ ...connection, authMode: 'oauth', token: '' })
      }
      return { ok: true, baseUrl, connected: true }
    } catch {
      return { ok: false, baseUrl, connected: false }
    }
  },
  async oauthLogoutConnectionConfig(remoteUrl: string) {
    const baseUrl = normalizeBaseUrl(remoteUrl)
    await clearTokens(baseUrl)
    const connection = readConnection()
    if (normalizeBaseUrl(connection.url) === baseUrl && connection.authMode === 'oauth') {
      persistConnection({ ...connection, authMode: 'token', token: '' })
    }
    return { ok: true, baseUrl: baseUrl, connected: false }
  },
  cloud: {
    async status() { return { portalBaseUrl: '', signedIn: false } },
    async login() { return { ok: false, portalBaseUrl: '', signedIn: false } },
    async logout() { return { ok: true, portalBaseUrl: '', signedIn: false } },
    async discover() { return { agents: [], org: null } },
    async agentSignIn(dashboardUrl: string) { return { baseUrl: dashboardUrl, connected: false } },
  },
  profile: {
    async get() { return { profile: readStorage(PROFILE_KEY) || null } },
    async remember(name: string | null) { writeStorage(PROFILE_KEY, name ?? ''); return { profile: name } },
    async set(name: string | null): Promise<{ profile: string | null }> { return bridge.profile.remember(name) },
  },
  async api<T>(input: HermesApiRequest) {
    return (await request(await resolveConnection(input.connectionId), input)) as T
  },
  async notify(payload) {
    if (document.visibilityState === 'visible') return false
    if (payload.silent) return false
    if (!(await ensureNotificationPermission())) return false
    const id = notificationId++
    await LocalNotifications.schedule({
      notifications: [{
        id,
        title: payload.title ?? 'Hermes',
        body: payload.body ?? '',
        extra: {
          sessionId: payload.sessionId,
          activate: payload.activate,
          notifyId: payload.notifyId,
          tag: payload.tag,
        },
      }],
    })
    return true
  },
  async requestMicrophoneAccess() {
    if (!navigator.mediaDevices?.getUserMedia) return false
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach(track => track.stop())
    return true
  },
  async readFileDataUrl(filePath: string) {
    const blob = await (await fetch(filePath)).blob()
    if (blob.size > MAX_FILE_BYTES) throw new Error('File exceeds the 25 MB mobile limit.')
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'))
      reader.onload = () => resolve(String(reader.result))
      reader.readAsDataURL(blob)
    })
  },
  async readFileText(_filePath: string) { return unsupportedError() },
  selectPaths: chooseFiles,
  async writeClipboard(text: string) { await navigator.clipboard?.writeText(text); return true },
  async readClipboard() { return (await navigator.clipboard?.readText()) ?? '' },
  async saveImageFromUrl(url: string) {
    try {
      const response = Capacitor.isNativePlatform()
        ? await CapacitorHttp.get({ url, responseType: 'arraybuffer' })
        : { data: await (await fetch(url)).arrayBuffer() }
      const bytes = new Uint8Array(response.data as ArrayBuffer)
      const ext = url.match(/\.(png|jpe?g|gif|webp|svg)/i)?.[1] ?? 'png'
      const filename = 'hermes-image-' + Date.now() + '.' + ext
      const base64 = uint8ToBase64(bytes)
      const saved = await Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: Directory.Cache,
      })
      await Share.share({ url: saved.uri, title: filename })
      return true
    } catch {
      return false
    }
  },
  async saveImageBuffer(data: ArrayBuffer | Uint8Array, ext: string, name?: string) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    const filename = name ?? ('hermes-image-' + Date.now() + (ext.startsWith('.') ? ext : '.' + ext))
    const base64 = uint8ToBase64(bytes)
    const saved = await Filesystem.writeFile({
      path: filename,
      data: base64,
      directory: Directory.Cache,
    })
    return saved.uri
  },
  async saveClipboardImage() {
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'))
        if (!imageType) continue
        const blob = await item.getType(imageType)
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const ext = imageType.split('/')[1] ?? 'png'
        const filename = 'clipboard-' + Date.now() + '.' + ext
        const base64 = uint8ToBase64(bytes)
        const saved = await Filesystem.writeFile({
          path: filename,
          data: base64,
          directory: Directory.Cache,
        })
        return saved.uri
      }
    } catch { /* clipboard may be empty or denied */ }
    return ''
  },
  async saveGatewayFile(payload: { connectionId?: null | string; path: string; profile?: null | string; suggestedName?: string }) {
    try {
      const connection = await resolveConnection(payload.connectionId)
      const data = await request(connection, {
        path: payload.path,
        profile: payload.profile ?? undefined,
        method: 'GET',
      })
      const filename = payload.suggestedName ?? payload.path.split('/').pop() ?? 'download'
      if (typeof data === 'string') {
        const saved = await Filesystem.writeFile({
          path: filename,
          data,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        })
        await Share.share({ url: saved.uri, title: filename })
      } else {
        const json = JSON.stringify(data)
        const saved = await Filesystem.writeFile({
          path: filename,
          data: json,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        })
        await Share.share({ url: saved.uri, title: filename })
      }
      return { saved: true, path: filename }
    } catch {
      return { saved: false, canceled: true }
    }
  },
  getPathForFile: (file: File) => URL.createObjectURL(file),
  async normalizePreviewTarget(target: string, _baseDir?: string) {
    try {
      const url = new URL(target)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      return { kind: 'url' as const, label: url.hostname, source: url.toString(), url: url.toString() }
    } catch { return null }
  },
  async watchPreviewFile() { return { id: '', path: '' } },
  async stopPreviewFileWatch(_id: string) { return false },
  setActiveWork: noOp,
  setNativeTheme: (mode: 'dark' | 'light' | 'system') => {
    if (Capacitor.isNativePlatform()) {
      void StatusBar.setStyle({
        style: mode === 'dark' ? Style.Dark : mode === 'light' ? Style.Light : Style.Default,
      })
    }
  },
  setKeepAwake: (on: boolean) => {
    if ('wakeLock' in navigator) {
      if (on) {
        void navigator.wakeLock.request('screen').then(lock => {
          (window as { __wakeLock?: WakeLockSentinel }).__wakeLock = lock
        }).catch(() => {})
      } else {
        const lock = (window as { __wakeLock?: WakeLockSentinel }).__wakeLock
        if (lock) { void lock.release(); (window as { __wakeLock?: WakeLockSentinel }).__wakeLock = undefined }
      }
    }
  },
  async openExternal(url: string) { window.open(url, '_blank', 'noopener,noreferrer') },
  async fetchLinkTitle(url: string) {
    const html = await (await fetch(url)).text()
    return /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? ''
  },
  async sanitizeWorkspaceCwd(cwd?: string | null) { return { cwd: cwd ?? '', sanitized: false } },
  settings: {
    async getDefaultProjectDir() { return { dir: null, defaultLabel: '', resolvedCwd: '' } },
    async pickDefaultProjectDir() { return { canceled: true as boolean, dir: null as string | null } },
    async setDefaultProjectDir() { return { dir: null } },
  },
  zoom: {
    async get() { return { level: 0, percent: 100 } },
    factor: () => 1, setPercent: noOp, onChanged: noOpUnsubscribe,
  },
  async revealLogs() { return { ok: false, path: '', error: 'unsupported' } },
  async getRecentLogs() { return { path: '', lines: [] } },
  async readDir(_path: string) { return { entries: [], error: 'unsupported' } },
  terminal: {
    attach: async () => false, cwd: async () => null, dispose: async () => false,
    onData: noOpUnsubscribe, onExit: noOpUnsubscribe, resize: async () => false,
    start: async () => unsupportedError(), write: async () => false,
  },
  onNotificationAction: (callback: NotificationActionCallback) => {
    notificationActionListeners.add(callback)
    return () => { notificationActionListeners.delete(callback) }
  },
  onNotificationActivate: (callback: NotificationActivateCallback) => {
    notificationActivateListeners.add(callback)
    return () => { notificationActivateListeners.delete(callback) }
  },
  getOnBattery,
  onBatteryChanged,
  onDeepLink: onDeepLink,
  signalDeepLinkReady: async () => signalDeepLinkReady(),
  onPreviewFileChanged: noOpUnsubscribe,
  onBackendExit: noOpUnsubscribe,
  onConnectionApplied: noOpUnsubscribe,
  onPowerResume: (callback: () => void) => {
    const listener = () => { if (document.visibilityState === 'visible') callback() }
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
  onBootProgress: (callback: (payload: DesktopBootProgress) => void) => {
    queueMicrotask(() => callback(bootProgress()))
    return noOp
  },
  getBootstrapState: async () => emptyBootstrapState(),
  continueBootstrapLocal: async () => ({ ok: false }),
  resetBootstrap: async () => ({ ok: false }),
  repairBootstrap: async () => ({ ok: false }),
  cancelBootstrap: async () => ({ ok: false, cancelled: false }),
  onBootstrapEvent: noOpUnsubscribe,
  getVersion: async () => ({
    appVersion: '0.1.0', electronVersion: '', nodeVersion: '', platform: 'ios', hermesRoot: UPSTREAM_SHA,
  }),
  updates: {
    check: async () => ({ supported: false }),
    apply: async () => ({ ok: false, manual: true, command: 'hermes update' }),
    getBranch: async () => ({ branch: '' }),
    setBranch: async (branch: string) => ({ branch }),
    onProgress: noOpUnsubscribe,
  },
  uninstall: {
    summary: async () => ({
      hermes_home: '', agent_installed: false, gui_installed: false, source_built_artifacts: [],
      packaged_app_paths: [], userdata_dir: '', userdata_exists: false, platform: 'ios',
    }),
    run: async () => ({ ok: false, error: 'unsupported' }),
  },
  themes: {
    fetchMarketplace,
    searchMarketplace,
  },
  findInPage: async () => ({ count: 0 }),
  stopFindInPage: async (): Promise<void> => {},
  onFoundInPage: noOpUnsubscribe,
  onOpenFindBarRequested: noOpUnsubscribe,
} satisfies Window['hermesDesktop']

export async function installHermesMobileBridge(): Promise<void> {
  document.documentElement.dataset.hermesHost = 'mobile'
  window.hermesDesktop = bridge
  initNotificationListeners()
  initDeepLinkListener()
  void initNetworkMonitor()

  const nativeTrigger = getNativeHapticTrigger()
  if (nativeTrigger) {
    const { registerHapticTrigger } = await import('@upstream/lib/haptics')
    registerHapticTrigger(nativeTrigger)
  }

  installEdgeSwipe((edge) => {
    if (edge === 'left') {
      const trigger = document.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')
      if (trigger) {
        void hapticTick()
        trigger.click()
      }
    }
  })
}
