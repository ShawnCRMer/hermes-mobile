import { Network } from '@capacitor/network'
import { Capacitor } from '@capacitor/core'
import { isLocalEnabled, getLocalState } from './local-connection'
import { getOnDeviceStatus, onModelStatusChanged } from './model-manager'

let statusBanner: HTMLElement | null = null
let currentlyConnected = true
let hasLocalModel = false

type NetworkMode = 'online' | 'offline-local' | 'offline-cloud' | 'local-only'

function resolveMode(): NetworkMode {
  const localEnabled = isLocalEnabled()
  const localReady = getLocalState().phase === 'ready'
  const onDeviceActive = getOnDeviceStatus().activeModelId !== null

  if (currentlyConnected) {
    if (localEnabled && localReady && onDeviceActive) return 'local-only'
    return 'online'
  }

  if (localEnabled && localReady && onDeviceActive) return 'offline-local'
  return 'offline-cloud'
}

function createBanner(): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-slot', 'mobile-network-status')
  el.hidden = true
  document.body.prepend(el)
  return el
}

function updateBanner(): void {
  if (!statusBanner) statusBanner = createBanner()

  const mode = resolveMode()

  switch (mode) {
    case 'online':
      statusBanner.hidden = true
      break

    case 'local-only':
      statusBanner.hidden = false
      statusBanner.textContent = 'On-device mode'
      statusBanner.className = 'network-status network-status--local'
      break

    case 'offline-local':
      statusBanner.hidden = false
      statusBanner.textContent = 'Offline — using on-device model'
      statusBanner.className = 'network-status network-status--offline-local'
      break

    case 'offline-cloud':
      statusBanner.hidden = false
      statusBanner.textContent = 'No connection — cloud provider unavailable'
      statusBanner.className = 'network-status network-status--offline-cloud'
      break
  }
}

export async function initNetworkMonitor(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return

  const status = await Network.getStatus()
  currentlyConnected = status.connected
  hasLocalModel = getOnDeviceStatus().activeModelId !== null

  updateBanner()

  Network.addListener('networkStatusChange', (s) => {
    currentlyConnected = s.connected
    updateBanner()
  })

  onModelStatusChanged((status) => {
    const newHasLocal = status.activeModelId !== null
    if (newHasLocal !== hasLocalModel) {
      hasLocalModel = newHasLocal
      updateBanner()
    }
  })
}
