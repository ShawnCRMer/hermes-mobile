import { Device } from '@capacitor/device'
import { Capacitor } from '@capacitor/core'

type BatteryCallback = (onBattery: boolean) => void

const batteryListeners = new Set<BatteryCallback>()
let lastOnBattery: boolean | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

async function checkBattery(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false
  try {
    const info = await Device.getBatteryInfo()
    return info.isCharging === false
  } catch {
    return false
  }
}

function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    if (batteryListeners.size === 0) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      return
    }
    const onBattery = await checkBattery()
    if (onBattery !== lastOnBattery) {
      lastOnBattery = onBattery
      for (const cb of batteryListeners) cb(onBattery)
    }
  }, 30_000)
}

export async function getOnBattery(): Promise<boolean> {
  lastOnBattery = await checkBattery()
  return lastOnBattery
}

export function onBatteryChanged(callback: BatteryCallback): () => void {
  batteryListeners.add(callback)
  startPolling()
  return () => {
    batteryListeners.delete(callback)
    if (batteryListeners.size === 0 && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
}
