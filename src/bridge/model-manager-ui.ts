import { Capacitor, registerPlugin } from '@capacitor/core'
import {
  getOnDeviceStatus,
  onModelStatusChanged,
  getModelCatalog,
  type ModelInfo,
  type ModelState,
  type OnDeviceStatus,
} from './model-manager'
import { isLocalEnabled, setLocalEnabled, getLocalState } from './local-connection'

interface ModelManagerPluginInterface {
  getStatus(): Promise<OnDeviceStatus>
  downloadModel(opts: { modelId: string }): Promise<{ ok: boolean }>
  cancelDownload(opts: { modelId: string }): Promise<{ ok: boolean }>
  deleteModel(opts: { modelId: string }): Promise<{ ok: boolean }>
  setActiveModel(opts: { modelId?: string | null }): Promise<{ ok: boolean }>
  getInferencePort(): Promise<{ port: number; running: boolean }>
  addListener(event: string, callback: (data: Record<string, unknown>) => void): Promise<{ remove(): void }>
}

const NativeModelManager = Capacitor.isNativePlatform()
  ? registerPlugin<ModelManagerPluginInterface>('ModelManager')
  : null

let sheetEl: HTMLElement | null = null
let fabEl: HTMLElement | null = null
let isOpen = false

function gbLabel(bytes: number): string {
  return `${(bytes / (1 << 30)).toFixed(1)} GB`
}

function stateLabel(state: ModelState): string {
  switch (state.status) {
    case 'notDownloaded': return 'Not downloaded'
    case 'downloading': return `Downloading ${Math.round((state.progress ?? 0) * 100)}%`
    case 'downloaded': return 'Ready to load'
    case 'loading': return 'Loading…'
    case 'loaded': return 'Active'
    case 'error': return `Error: ${state.message ?? 'unknown'}`
  }
}

function tierLabel(tier: string): string {
  switch (tier) {
    case 'default': return 'Recommended'
    case 'onBrand': return 'Hermes'
    case 'fast': return 'Fast'
    case 'efficient': return 'Efficient'
    default: return tier
  }
}

function createSheet(): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-slot', 'mobile-model-manager')
  el.hidden = true
  document.body.appendChild(el)
  return el
}

function createFab(): HTMLElement {
  const btn = document.createElement('button')
  btn.setAttribute('data-slot', 'mobile-model-fab')
  btn.setAttribute('aria-label', 'Models')
  btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`
  btn.addEventListener('click', () => openSheet())
  document.body.appendChild(btn)
  return btn
}

function renderSheet(): void {
  if (!sheetEl) return
  const status = getOnDeviceStatus()
  const localEnabled = isLocalEnabled()
  const localPhase = getLocalState().phase

  sheetEl.innerHTML = `
    <div class="mm-backdrop" data-action="close"></div>
    <div class="mm-panel">
      <div class="mm-header">
        <h2>On-Device Models</h2>
        <button class="mm-close" data-action="close" aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="mm-section">
        <div class="mm-toggle-row">
          <div>
            <div class="mm-toggle-label">Local Inference</div>
            <div class="mm-toggle-sub">${localEnabled ? (localPhase === 'ready' ? 'Gateway running' : localPhase === 'error' ? 'Gateway error' : 'Starting…') : 'Use on-device models'}</div>
          </div>
          <button class="mm-toggle ${localEnabled ? 'mm-toggle--on' : ''}" data-action="toggle-local" aria-pressed="${localEnabled}">
            <span class="mm-toggle-thumb"></span>
          </button>
        </div>
      </div>

      <div class="mm-section">
        <div class="mm-section-title">Models</div>
        ${status.models.map(m => renderModelCard(m, status.activeModelId)).join('')}
      </div>

      <div class="mm-footer">
        <span>Storage: ${gbLabel(status.storageUsed)}</span>
        ${status.inferenceServerPort > 0 ? `<span>Server: port ${status.inferenceServerPort}</span>` : '<span>Server: stopped</span>'}
      </div>
    </div>
  `

  sheetEl.addEventListener('click', handleSheetClick)
}

function renderModelCard(model: ModelInfo & { state: ModelState }, activeId: string | null): string {
  const isActive = model.id === activeId
  const st = model.state
  const progressBar = st.status === 'downloading'
    ? `<div class="mm-progress"><div class="mm-progress-bar" style="width:${Math.round((st.progress ?? 0) * 100)}%"></div></div>`
    : ''

  let actions = ''
  switch (st.status) {
    case 'notDownloaded':
      actions = `<button class="mm-btn mm-btn--primary" data-action="download" data-model="${model.id}">Download</button>`
      break
    case 'downloading':
      actions = `<button class="mm-btn mm-btn--secondary" data-action="cancel" data-model="${model.id}">Cancel</button>`
      break
    case 'downloaded':
      actions = `
        <button class="mm-btn mm-btn--primary" data-action="activate" data-model="${model.id}">Load</button>
        <button class="mm-btn mm-btn--danger" data-action="delete" data-model="${model.id}">Delete</button>
      `
      break
    case 'loading':
      actions = `<button class="mm-btn mm-btn--secondary" disabled>Loading…</button>`
      break
    case 'loaded':
      actions = `
        <button class="mm-btn mm-btn--secondary" data-action="unload" data-model="${model.id}">Unload</button>
        <button class="mm-btn mm-btn--danger" data-action="delete" data-model="${model.id}">Delete</button>
      `
      break
    case 'error':
      actions = `
        <button class="mm-btn mm-btn--primary" data-action="download" data-model="${model.id}">Retry</button>
        <button class="mm-btn mm-btn--danger" data-action="delete" data-model="${model.id}">Delete</button>
      `
      break
  }

  return `
    <div class="mm-card ${isActive ? 'mm-card--active' : ''}">
      <div class="mm-card-header">
        <div class="mm-card-name">${model.displayName}</div>
        <span class="mm-card-tier">${tierLabel(model.tier)}</span>
      </div>
      <div class="mm-card-meta">
        ${gbLabel(model.sizeBytes)} · ${model.format.toUpperCase()} · ${(model.contextLength / 1024).toFixed(0)}K ctx${model.supportsTools ? ' · Tools' : ''}
      </div>
      <div class="mm-card-status">${stateLabel(st)}</div>
      ${progressBar}
      <div class="mm-card-actions">${actions}</div>
    </div>
  `
}

function handleSheetClick(e: Event): void {
  const target = e.target as HTMLElement
  const actionEl = target.closest<HTMLElement>('[data-action]')
  if (!actionEl) return

  const action = actionEl.dataset.action
  const modelId = actionEl.dataset.model

  switch (action) {
    case 'close':
      closeSheet()
      break
    case 'toggle-local':
      setLocalEnabled(!isLocalEnabled())
      renderSheet()
      break
    case 'download':
      if (modelId && NativeModelManager) {
        NativeModelManager.downloadModel({ modelId })
      }
      break
    case 'cancel':
      if (modelId && NativeModelManager) {
        NativeModelManager.cancelDownload({ modelId })
      }
      break
    case 'activate':
      if (modelId && NativeModelManager) {
        NativeModelManager.setActiveModel({ modelId })
      }
      break
    case 'unload':
      if (NativeModelManager) {
        NativeModelManager.setActiveModel({ modelId: null })
      }
      break
    case 'delete':
      if (modelId && NativeModelManager) {
        NativeModelManager.deleteModel({ modelId })
      }
      break
  }
}

export function openSheet(): void {
  if (!sheetEl) sheetEl = createSheet()
  renderSheet()
  sheetEl.hidden = false
  requestAnimationFrame(() => {
    sheetEl?.classList.add('mm-open')
  })
  isOpen = true
}

function closeSheet(): void {
  if (!sheetEl) return
  sheetEl.classList.remove('mm-open')
  setTimeout(() => {
    if (sheetEl) sheetEl.hidden = true
  }, 300)
  isOpen = false
}

export function initModelManagerUI(): void {
  fabEl = createFab()

  onModelStatusChanged(() => {
    if (isOpen) renderSheet()
    updateFabBadge()
  })

  updateFabBadge()
}

function updateFabBadge(): void {
  if (!fabEl) return
  const status = getOnDeviceStatus()
  const hasActive = status.activeModelId !== null
  fabEl.classList.toggle('mm-fab--active', hasActive)
}
