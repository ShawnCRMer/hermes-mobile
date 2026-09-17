import { Capacitor, registerPlugin } from '@capacitor/core'
import {
  getOnDeviceStatus,
  updateModelState,
  setActiveModel,
  setStorageUsed,
  getModelCatalog,
  type ModelInfo,
  type ModelState,
  type OnDeviceStatus,
} from './model-manager'

interface ModelManagerPluginInterface {
  getStatus(): Promise<{ status: string }>
  downloadModel(options: { modelId: string; repo: string }): Promise<void>
  cancelDownload(options: { modelId: string }): Promise<void>
  deleteModel(options: { modelId: string }): Promise<void>
  setActiveModel(options: { modelId: string }): Promise<void>
  getInferencePort(): Promise<{ port: number }>
}

const ModelManager = registerPlugin<ModelManagerPluginInterface>('ModelManager')

function gbLabel(bytes: number): string {
  return `${(bytes / (1 << 30)).toFixed(1)} GB`
}

function mapStatus(device: OnDeviceStatus): Record<string, unknown> {
  const loadedModels: Record<string, string> = {}
  for (const m of device.models) {
    if (m.state.status === 'loaded') loadedModels[m.id] = 'ready'
    else if (m.state.status === 'loading') loadedModels[m.id] = 'loading'
  }

  return {
    enabled: true,
    tag: 'mlx-swift',
    configured_tag: 'mlx-swift',
    update_available: false,
    runtime_installed: true,
    runtime_backend: 'mlx',
    server_running: device.inferenceServerPort > 0,
    server_base_url: device.inferenceServerPort > 0
      ? `http://127.0.0.1:${device.inferenceServerPort}`
      : null,
    active_model_id: device.activeModelId,
    loaded_models: loadedModels,
    placement: {},
    models: device.models
      .filter(m => m.state.status === 'downloaded' || m.state.status === 'loaded')
      .map(m => ({
        id: m.id,
        size_bytes: m.sizeBytes,
        size_label: gbLabel(m.sizeBytes),
      })),
    models_dir: 'Application Support/models',
  }
}

function mapCatalog(device: OnDeviceStatus): { models: Record<string, unknown>[] } {
  return {
    models: device.models.map((m, i) => ({
      id: m.id,
      display_name: m.displayName,
      description: `${m.format.toUpperCase()} · ${m.contextLength.toLocaleString()} ctx · ${m.supportsTools ? 'Tool calling' : 'Chat only'}`,
      size_bytes: m.sizeBytes,
      size_label: gbLabel(m.sizeBytes),
      native_context: m.contextLength,
      native_context_label: `${(m.contextLength / 1024).toFixed(0)}K`,
      recommended: i === 0,
      recommended_reason: i === 0 ? 'best-quality-resident' : null,
      downloaded: m.state.status === 'downloaded' || m.state.status === 'loaded',
      downloaded_model_id: m.id,
      mtp: false,
      vision: false,
      fits: true,
      fit_summary: 'Runs on Apple Neural Engine + GPU',
      spilled: false,
      model_id: m.id,
      start_window: m.contextLength,
      start_window_label: `${(m.contextLength / 1024).toFixed(0)}K`,
    })),
  }
}

function mapHardware(): Record<string, unknown> {
  const totalMemGB = (navigator as { deviceMemory?: number }).deviceMemory ?? 8
  const totalBytes = totalMemGB * (1 << 30)
  return {
    uma: true,
    vram_total_bytes: totalBytes,
    vram_usable_bytes: totalBytes,
    ram_total_bytes: totalBytes,
    ram_available_bytes: Math.floor(totalBytes * 0.6),
    vram_label: `${totalMemGB} GB`,
    gpu_name: 'Apple Neural Engine + GPU',
    gpu_util_percent: null,
    vram_used_bytes: null,
  }
}

const activeJobs = new Map<string, {
  kind: string
  target: string
  modelId: string
  status: string
  phase: string
  detail: string
  totalBytes: number
  doneBytes: number
  percent: number
  error: string | null
}>()

function getJobs(): Record<string, unknown>[] {
  return Array.from(activeJobs.entries()).map(([jobId, j]) => ({
    job_id: jobId,
    kind: j.kind,
    target: j.target,
    model_id: j.modelId,
    status: j.status,
    phase: j.phase,
    detail: j.detail,
    total_bytes: j.totalBytes,
    done_bytes: j.doneBytes,
    percent: j.percent,
    error: j.error,
  }))
}

export function handleLocalModelsApi(
  path: string,
  method?: string,
  body?: unknown,
): Promise<unknown> | null {
  if (!path.startsWith('/api/local-models')) return null

  const route = path.replace('/api/local-models', '')

  if (route === '/status' || route === '/status/') {
    return Promise.resolve(mapStatus(getOnDeviceStatus()))
  }

  if (route === '/hardware' || route === '/hardware/') {
    return Promise.resolve(mapHardware())
  }

  if (route === '/catalog' || route === '/catalog/') {
    return Promise.resolve(mapCatalog(getOnDeviceStatus()))
  }

  if (route === '/jobs' || route === '/jobs/') {
    return Promise.resolve({ jobs: getJobs() })
  }

  if (route.startsWith('/jobs/')) {
    const jobId = decodeURIComponent(route.replace('/jobs/', ''))
    const job = activeJobs.get(jobId)
    if (job) {
      return Promise.resolve({
        job_id: jobId,
        kind: job.kind,
        target: job.target,
        model_id: job.modelId,
        status: job.status,
        phase: job.phase,
        detail: job.detail,
        total_bytes: job.totalBytes,
        done_bytes: job.doneBytes,
        percent: job.percent,
        error: job.error,
      })
    }
    return Promise.resolve({ job_id: jobId, kind: 'unknown', target: '', model_id: null, status: 'done', phase: '', detail: '', total_bytes: null, done_bytes: 0, error: null })
  }

  if (route === '/download' && method === 'POST') {
    const { model_id } = (body ?? {}) as { model_id?: string }
    if (!model_id) return Promise.reject(new Error('model_id required'))

    const model = getModelCatalog().find(m => m.id === model_id)
    if (!model) return Promise.reject(new Error('Unknown model'))

    const jobId = `dl-${model_id}-${Date.now()}`
    activeJobs.set(jobId, {
      kind: 'model-download',
      target: model.displayName,
      modelId: model_id,
      status: 'running',
      phase: 'downloading',
      detail: 'Starting download…',
      totalBytes: model.sizeBytes,
      doneBytes: 0,
      percent: 0,
      error: null,
    })

    updateModelState(model_id, { status: 'downloading', progress: 0 })

    if (Capacitor.isNativePlatform()) {
      ModelManager.downloadModel({ modelId: model_id, repo: model.huggingFaceRepo }).catch(err => {
        activeJobs.set(jobId, { ...activeJobs.get(jobId)!, status: 'error', error: String(err) })
        updateModelState(model_id, { status: 'error', message: String(err) })
      })
    }

    return Promise.resolve({ job_id: jobId })
  }

  if (route === '/activate' && method === 'POST') {
    const { model_id } = (body ?? {}) as { model_id?: string }
    if (!model_id) return Promise.reject(new Error('model_id required'))

    const jobId = `act-${model_id}-${Date.now()}`
    activeJobs.set(jobId, {
      kind: 'model-activate',
      target: model_id,
      modelId: model_id,
      status: 'running',
      phase: 'loading',
      detail: 'Loading model…',
      totalBytes: 0,
      doneBytes: 0,
      percent: 0,
      error: null,
    })

    setActiveModel(model_id)

    if (Capacitor.isNativePlatform()) {
      ModelManager.setActiveModel({ modelId: model_id })
        .then(() => {
          activeJobs.set(jobId, { ...activeJobs.get(jobId)!, status: 'done', percent: 100 })
          updateModelState(model_id, { status: 'loaded' })
        })
        .catch(err => {
          activeJobs.set(jobId, { ...activeJobs.get(jobId)!, status: 'error', error: String(err) })
          updateModelState(model_id, { status: 'error', message: String(err) })
        })
    }

    return Promise.resolve({ job_id: jobId })
  }

  if (route.startsWith('/models/') && method === 'DELETE') {
    const modelId = decodeURIComponent(route.replace('/models/', ''))

    updateModelState(modelId, { status: 'notDownloaded' })

    if (Capacitor.isNativePlatform()) {
      ModelManager.deleteModel({ modelId }).catch(() => {})
    }

    return Promise.resolve({ ok: true })
  }

  if (route === '/eject' && method === 'POST') {
    const { model_id } = (body ?? {}) as { model_id?: string }
    if (!model_id) return Promise.reject(new Error('model_id required'))
    updateModelState(model_id, { status: 'downloaded' })
    return Promise.resolve({ ok: true })
  }

  if (route === '/server' && method === 'POST') {
    return Promise.resolve({ ok: true })
  }

  if (route === '/runtime/install' && method === 'POST') {
    return Promise.resolve({ backend: 'mlx', job_id: 'noop', tag: 'mlx-swift' })
  }

  if (route === '/quickstart' && method === 'POST') {
    const catalog = getModelCatalog()
    const model = catalog[0]
    return Promise.resolve({
      display_name: model.displayName,
      download_bytes: model.sizeBytes,
      job_id: 'noop',
      model_id: model.id,
      needs_download: true,
      needs_runtime: false,
    })
  }

  return Promise.resolve({})
}

export function updateDownloadProgress(modelId: string, progress: number, doneBytes: number, totalBytes: number): void {
  for (const [jobId, job] of activeJobs) {
    if (job.modelId === modelId && job.kind === 'model-download' && job.status === 'running') {
      activeJobs.set(jobId, {
        ...job,
        percent: Math.round(progress * 100),
        doneBytes,
        totalBytes,
        detail: `${gbLabel(doneBytes)} / ${gbLabel(totalBytes)}`,
      })
      break
    }
  }
  updateModelState(modelId, { status: 'downloading', progress })
}

export function completeDownload(modelId: string): void {
  for (const [jobId, job] of activeJobs) {
    if (job.modelId === modelId && job.kind === 'model-download') {
      activeJobs.set(jobId, { ...job, status: 'done', percent: 100, detail: 'Complete' })
      break
    }
  }
  updateModelState(modelId, { status: 'downloaded' })
}
