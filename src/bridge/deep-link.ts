import { App } from '@capacitor/app'
import { handleShareDeepLink } from './share-intake'

type DeepLinkPayload = { kind: string; name: string; params: Record<string, string> }
type DeepLinkCallback = (payload: DeepLinkPayload) => void

const listeners = new Set<DeepLinkCallback>()
let ready = false
const pendingLinks: DeepLinkPayload[] = []

function parseHermesUrl(url: string): DeepLinkPayload | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'hermes:') return null
    const pathParts = (parsed.hostname + parsed.pathname).replace(/^\/+|\/+$/g, '').split('/')
    const kind = pathParts[0] || ''
    const name = pathParts.slice(1).join('/') || ''
    const params: Record<string, string> = {}
    parsed.searchParams.forEach((v, k) => { params[k] = v })
    if (!kind) return null
    return { kind, name, params }
  } catch {
    return null
  }
}

function dispatch(payload: DeepLinkPayload): void {
  if (payload.kind === 'share') {
    handleShareDeepLink()
    return
  }
  if (!ready || listeners.size === 0) {
    pendingLinks.push(payload)
    return
  }
  for (const cb of listeners) cb(payload)
}

export function onDeepLink(callback: DeepLinkCallback): () => void {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}

export function signalDeepLinkReady(): { ok: boolean } {
  ready = true
  while (pendingLinks.length > 0) {
    const link = pendingLinks.shift()!
    for (const cb of listeners) cb(link)
  }
  return { ok: true }
}

export function initDeepLinkListener(): void {
  App.addListener('appUrlOpen', (event) => {
    const payload = parseHermesUrl(event.url)
    if (payload) dispatch(payload)
  })
}
