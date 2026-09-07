import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'
import { Capacitor } from '@capacitor/core'
import type { HapticTrigger } from '@upstream/lib/haptics'

type Vibration = { duration: number; intensity?: number; delay?: number }

function toVibrations(input: unknown): Vibration[] {
  if (!input) return []
  if (typeof input === 'string' || typeof input === 'number') return []

  if (typeof input === 'object' && 'pattern' in (input as object)) {
    const preset = input as { pattern: Vibration[] }
    return Array.isArray(preset.pattern) ? preset.pattern : []
  }

  if (!Array.isArray(input)) return []
  if (input.length === 0) return []
  if (typeof input[0] === 'number') return []
  return input as Vibration[]
}

function classifyVibrations(vibrations: Vibration[]): { style: 'impact'; impact: ImpactStyle } | { style: 'notification'; type: NotificationType } {
  const count = vibrations.length
  const peak = Math.max(...vibrations.map(s => s.intensity ?? 0.5))
  const totalDuration = vibrations.reduce((sum, s) => sum + (s.duration ?? 0) + (s.delay ?? 0), 0)

  if (count >= 3 && totalDuration > 80) {
    if (peak > 0.75) return { style: 'notification', type: NotificationType.Error }
    return { style: 'notification', type: NotificationType.Success }
  }

  if (count === 2 && peak > 0.6) {
    return { style: 'notification', type: NotificationType.Warning }
  }

  if (peak > 0.8) return { style: 'impact', impact: ImpactStyle.Heavy }
  if (peak > 0.5) return { style: 'impact', impact: ImpactStyle.Medium }
  return { style: 'impact', impact: ImpactStyle.Light }
}

const nativeHapticTrigger: HapticTrigger = async (input) => {
  const vibrations = toVibrations(input)
  if (vibrations.length === 0) {
    await Haptics.impact({ style: ImpactStyle.Light })
    return
  }

  const classified = classifyVibrations(vibrations)
  if (classified.style === 'notification') {
    await Haptics.notification({ type: classified.type })
  } else {
    await Haptics.impact({ style: classified.impact })
  }
}

export async function hapticTick(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Haptics.impact({ style: ImpactStyle.Light })
  }
}

export function getNativeHapticTrigger(): HapticTrigger | null {
  if (!Capacitor.isNativePlatform()) return null
  return nativeHapticTrigger
}
