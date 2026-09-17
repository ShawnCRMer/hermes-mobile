import { Capacitor, registerPlugin } from '@capacitor/core'
import type {
  DesktopBootProgress,
  DesktopConnectionConfig,
  HermesConnection,
} from '@/global'

interface LocalGatewayPluginInterface {
  getState(): Promise<{ available: boolean; phase: string; port: number; token: string; error: string | null }>
  addListener(event: string, callback: (data: Record<string, unknown>) => void): Promise<{ remove: () => void }>
}

const LocalGatewayNative = registerPlugin<LocalGatewayPluginInterface>('LocalGateway')

export type LocalGatewayState = {
  enabled: boolean
  phase: 'idle' | 'interpreter' | 'imports' | 'bind' | 'ready' | 'error'
  progress: number
  message: string
  error: string | null
  port: number
  token: string
}

const LOCAL_ENABLED_KEY = 'hermes-mobile.local.enabled'
const LOCAL_ID = 'local'
const LOCAL_LABEL = 'On-device'

type ProgressCallback = (state: LocalGatewayState) => void
const progressListeners = new Set<ProgressCallback>()

let localState: LocalGatewayState = {
  enabled: false,
  phase: 'idle',
  progress: 0,
  message: '',
  error: null,
  port: 0,
  token: '',
}

let localModeAvailable = Capacitor.isNativePlatform()

export function setLocalModeAvailable(available: boolean): void {
  localModeAvailable = available
}

export function isLocalModeAvailable(): boolean {
  return localModeAvailable
}

export function isLocalEnabled(): boolean {
  try {
    const stored = localStorage.getItem(LOCAL_ENABLED_KEY)
    if (stored === null && Capacitor.isNativePlatform()) return true
    return stored === '1'
  } catch {
    return false
  }
}

export function setLocalEnabled(on: boolean): void {
  try {
    localStorage.setItem(LOCAL_ENABLED_KEY, on ? '1' : '0')
  } catch {
    // Private browsing
  }
  localState = { ...localState, enabled: on }
  if (!on) {
    localState = { ...localState, phase: 'idle', progress: 0, port: 0, token: '' }
    delete document.documentElement.dataset.localMode
  } else {
    document.documentElement.dataset.localMode = '1'
  }
}

export function getLocalState(): LocalGatewayState {
  return localState
}

export function updateLocalState(update: Partial<LocalGatewayState>): void {
  localState = { ...localState, ...update }
  if (localState.enabled) {
    document.documentElement.dataset.localMode = '1'
  } else {
    delete document.documentElement.dataset.localMode
  }
  for (const cb of progressListeners) cb(localState)
}

export function onLocalProgress(callback: ProgressCallback): () => void {
  progressListeners.add(callback)
  return () => { progressListeners.delete(callback) }
}

export function localBaseUrl(): string {
  return `http://127.0.0.1:${localState.port}`
}

export function localWsUrl(): string {
  const url = new URL(`http://127.0.0.1:${localState.port}/api/ws`)
  url.protocol = 'ws:'
  if (localState.token) url.searchParams.set('token', localState.token)
  return url.toString()
}

export function localConnectionDescriptor(): HermesConnection {
  return {
    baseUrl: localBaseUrl(),
    isFullscreen: false,
    mode: 'local',
    authMode: 'token',
    nativeOverlayWidth: 0,
    remoteKind: 'url',
    source: 'settings',
    token: localState.token,
    wsUrl: localWsUrl(),
    logs: [],
    windowButtonPosition: null,
    connectionId: LOCAL_ID,
    registryScoped: true,
  }
}

export function localBootProgress(): DesktopBootProgress {
  return {
    running: localState.phase !== 'idle' && localState.phase !== 'ready' && localState.phase !== 'error',
    progress: localState.progress,
    phase: localState.phase,
    error: localState.error,
    fakeMode: false,
    message: localState.message,
    timestamp: Date.now(),
  }
}

export function localConnectionConfig(): DesktopConnectionConfig {
  return {
    envOverride: false,
    mode: 'local',
    profile: null,
    remoteAuthMode: 'token',
    remoteOauthConnected: false,
    remoteTokenPreview: localState.token ? localState.token.slice(0, 4) + '…' : null,
    remoteTokenSet: Boolean(localState.token),
    secureTokenStorage: true,
    remoteTokenPlainText: false,
    remoteUrl: localBaseUrl(),
    cloudOrg: '',
    sshHost: '',
    sshUser: '',
    sshPort: null,
    sshKeyPath: '',
    sshRemoteHermesPath: '',
    sshRemoteProfile: '',
  }
}

export function localRegistryEntry() {
  return {
    id: LOCAL_ID,
    kind: 'local' as const,
    label: LOCAL_LABEL,
    url: localBaseUrl(),
    authMode: 'token' as const,
    tokenSet: Boolean(localState.token),
    tokenPreview: localState.token ? localState.token.slice(0, 4) + '…' : null,
  }
}

export function isLocalConnectionId(id: string | null | undefined): boolean {
  return id === LOCAL_ID
}

let bridgeInitPromise: Promise<void> | null = null

export function waitForLocalBridgeInit(): Promise<void> {
  return bridgeInitPromise ?? Promise.resolve()
}

export function waitForLocalReady(timeoutMs: number): Promise<void> {
  if (localState.phase === 'ready') return Promise.resolve()
  return new Promise<void>(resolve => {
    const unsub = onLocalProgress(state => {
      if (state.phase === 'ready' || state.phase === 'error') {
        unsub()
        clearTimeout(timer)
        resolve()
      }
    })
    const timer = setTimeout(() => { unsub(); resolve() }, timeoutMs)
  })
}

export async function initLocalGatewayBridge(): Promise<void> {
  bridgeInitPromise = _initLocalGatewayBridge()
  return bridgeInitPromise
}

async function _initLocalGatewayBridge(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return

  try {
    const state = await LocalGatewayNative.getState()
    localModeAvailable = state.available
    updateLocalState({
      phase: state.phase as LocalGatewayState['phase'],
      port: state.port,
      token: state.token,
      error: state.error,
      enabled: state.available && isLocalEnabled(),
    })
  } catch {
    // Plugin may not be available
  }

  try {
    await LocalGatewayNative.addListener('localGatewayProgress', (data: Record<string, unknown>) => {
      updateLocalState({
        phase: String(data.phase ?? 'idle') as LocalGatewayState['phase'],
        progress: Number(data.progress ?? 0),
        message: String(data.message ?? ''),
        error: data.error ? String(data.error) : null,
      })
    })

    await LocalGatewayNative.addListener('localGatewayReady', (data: Record<string, unknown>) => {
      updateLocalState({
        phase: 'ready',
        progress: 100,
        port: Number(data.port ?? 0),
        token: String(data.token ?? ''),
        enabled: localModeAvailable && isLocalEnabled(),
      })
    })
  } catch {
    // Plugin may not be available
  }
}

export async function localApiRequest(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<unknown> {
  const url = new URL(path, localBaseUrl() + '/')
  const controller = new AbortController()
  const timeout = options?.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined
  try {
    const headers: Record<string, string> = {}
    if (localState.token) headers['X-Hermes-Session-Token'] = localState.token
    const init: RequestInit = {
      method: options?.method ?? 'GET',
      headers,
      signal: controller.signal,
    }
    if (options?.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
    const response = await fetch(url.toString(), init)
    const text = await response.text()
    try { return JSON.parse(text) } catch { return text }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
