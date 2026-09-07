import { Network } from '@capacitor/network'
import { Capacitor } from '@capacitor/core'

let offlineBanner: HTMLElement | null = null

function createBanner(): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-slot', 'mobile-offline-banner')
  el.textContent = 'No connection'
  el.hidden = true
  document.body.prepend(el)
  return el
}

function showBanner(connected: boolean): void {
  if (!offlineBanner) offlineBanner = createBanner()
  offlineBanner.hidden = connected
}

export async function initNetworkMonitor(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return

  const status = await Network.getStatus()
  showBanner(status.connected)

  Network.addListener('networkStatusChange', (s) => {
    showBanner(s.connected)
  })
}
