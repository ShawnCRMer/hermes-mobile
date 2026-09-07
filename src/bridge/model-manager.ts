export type ModelFormat = 'mlx' | 'gguf'
export type ModelTier = 'default' | 'onBrand' | 'fast' | 'efficient' | 'zeroDownload'

export interface ModelInfo {
  id: string
  displayName: string
  huggingFaceRepo: string
  format: ModelFormat
  sizeBytes: number
  tier: ModelTier
  contextLength: number
  supportsTools: boolean
}

export type ModelState =
  | { status: 'notDownloaded' }
  | { status: 'downloading'; progress: number }
  | { status: 'downloaded' }
  | { status: 'loading' }
  | { status: 'loaded' }
  | { status: 'error'; message: string }

export interface OnDeviceStatus {
  available: boolean
  inferenceServerPort: number
  activeModelId: string | null
  models: Array<ModelInfo & { state: ModelState }>
  storageUsed: number
}

const MODEL_CATALOG: ModelInfo[] = [
  {
    id: 'qwen3-4b-4bit',
    displayName: 'Qwen3 4B',
    huggingFaceRepo: 'mlx-community/Qwen3-4B-4bit',
    format: 'mlx',
    sizeBytes: 2_500_000_000,
    tier: 'default',
    contextLength: 32768,
    supportsTools: true,
  },
  {
    id: 'hermes-3-llama-3.2-3b-4bit',
    displayName: 'Hermes 3 3B',
    huggingFaceRepo: 'mlx-community/Hermes-3-Llama-3.2-3B-4bit',
    format: 'mlx',
    sizeBytes: 1_800_000_000,
    tier: 'onBrand',
    contextLength: 8192,
    supportsTools: true,
  },
  {
    id: 'qwen3-1.7b-4bit',
    displayName: 'Qwen3 1.7B',
    huggingFaceRepo: 'mlx-community/Qwen3-1.7B-4bit',
    format: 'mlx',
    sizeBytes: 1_000_000_000,
    tier: 'fast',
    contextLength: 32768,
    supportsTools: true,
  },
  {
    id: 'gemma-3n-e2b-4bit',
    displayName: 'Gemma 3n E2B',
    huggingFaceRepo: 'mlx-community/gemma-3n-E2B-it-4bit',
    format: 'mlx',
    sizeBytes: 1_600_000_000,
    tier: 'efficient',
    contextLength: 8192,
    supportsTools: true,
  },
]

const MODEL_STATE_KEY = 'hermes-mobile.models.state'

type StateChangeCallback = (status: OnDeviceStatus) => void
const stateListeners = new Set<StateChangeCallback>()

let currentModelStates: Record<string, ModelState> = {}
let activeModelId: string | null = null
let inferenceServerPort = 0
let storageUsed = 0

function loadPersistedState(): void {
  try {
    const raw = localStorage.getItem(MODEL_STATE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      activeModelId = parsed.activeModelId ?? null
      if (parsed.downloadedModels && Array.isArray(parsed.downloadedModels)) {
        for (const id of parsed.downloadedModels) {
          currentModelStates[id] = { status: 'downloaded' }
        }
      }
    }
  } catch {
    // Fresh state
  }
}

function persistState(): void {
  try {
    const downloadedModels = Object.entries(currentModelStates)
      .filter(([, s]) => s.status === 'downloaded' || s.status === 'loaded')
      .map(([id]) => id)
    localStorage.setItem(MODEL_STATE_KEY, JSON.stringify({ activeModelId, downloadedModels }))
  } catch {
    // Private browsing
  }
}

function notifyListeners(): void {
  const status = getOnDeviceStatus()
  for (const cb of stateListeners) cb(status)
}

export function getOnDeviceStatus(): OnDeviceStatus {
  return {
    available: true,
    inferenceServerPort,
    activeModelId,
    models: MODEL_CATALOG.map(m => ({
      ...m,
      state: currentModelStates[m.id] ?? { status: 'notDownloaded' as const },
    })),
    storageUsed,
  }
}

export function setInferenceServerPort(port: number): void {
  inferenceServerPort = port
  notifyListeners()
}

export function updateModelState(modelId: string, state: ModelState): void {
  currentModelStates[modelId] = state
  if (state.status === 'downloaded' || state.status === 'notDownloaded') {
    persistState()
  }
  notifyListeners()
}

export function setActiveModel(modelId: string | null): void {
  activeModelId = modelId
  persistState()
  notifyListeners()
}

export function setStorageUsed(bytes: number): void {
  storageUsed = bytes
  notifyListeners()
}

export function onModelStatusChanged(callback: StateChangeCallback): () => void {
  stateListeners.add(callback)
  return () => { stateListeners.delete(callback) }
}

export function getModelCatalog(): ModelInfo[] {
  return MODEL_CATALOG
}

export function initModelManager(): void {
  loadPersistedState()
}
