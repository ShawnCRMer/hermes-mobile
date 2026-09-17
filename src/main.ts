import { installHermesMobileBridge } from './bridge'
import './styles/mobile.css'

await installHermesMobileBridge()

const shellMode = (() => {
  try { return localStorage.getItem('hermes:shell') } catch { return null }
})()

if (shellMode === 'desktop') {
  // OG mode: load the full upstream desktop renderer
  // @ts-expect-error Vite resolves .tsx; TS does not allow the extension
  await import('@upstream/main.tsx')
} else {
  // Mobile shell: tab-bar layout replacing desktop ContribController
  // @ts-expect-error Vite resolves .tsx; TS does not allow the extension
  await import('./shell/main.tsx')
}
