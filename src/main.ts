import { installHermesMobileBridge } from './bridge'
import './styles/mobile.css'

await installHermesMobileBridge()
// @ts-expect-error Vite resolves .tsx; TS does not allow the extension
await import('@upstream/main.tsx')
