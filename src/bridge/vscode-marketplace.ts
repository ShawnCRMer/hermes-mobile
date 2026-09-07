import { CapacitorHttp } from '@capacitor/core'
import type {
  DesktopMarketplaceSearchItem,
  DesktopMarketplaceThemeFile,
  DesktopMarketplaceThemeResult,
} from '@/global'

const GALLERY_QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery'
const VSIX_ASSET_TYPE = 'Microsoft.VisualStudio.Services.VSIXPackage'
const MAX_VSIX_BYTES = 40 * 1024 * 1024
const ID_RE = /^[\w-]+\.[\w-]+$/

async function queryGallery(payload: unknown): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload)
  const response = await CapacitorHttp.post({
    url: GALLERY_QUERY_URL,
    headers: {
      Accept: 'application/json;api-version=3.0-preview.1',
      'Content-Type': 'application/json',
      'User-Agent': 'Hermes-Mobile',
    },
    data: body,
    responseType: 'json',
    connectTimeout: 20_000,
    readTimeout: 20_000,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Gallery query failed (${response.status})`)
  }
  return response.data as Record<string, unknown>
}

function looksLikeIconTheme(extension: Record<string, unknown>): boolean {
  const tags = (extension.tags as string[] ?? []).map(t => String(t).toLowerCase())
  if (tags.includes('icon-theme') || tags.includes('product-icon-theme')) return true
  const text = `${extension.displayName ?? ''} ${extension.shortDescription ?? ''}`.toLowerCase()
  return /\b(icon theme|file icons?|product icons?|icon pack|fileicons)\b/.test(text)
}

export async function searchMarketplace(query: string): Promise<DesktopMarketplaceSearchItem[]> {
  const text = String(query || '').trim()
  const pageSize = 20

  const criteria: { filterType: number; value: string }[] = [
    { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
    { filterType: 5, value: 'Themes' },
    { filterType: 12, value: '4096' },
  ]
  if (text) criteria.push({ filterType: 10, value: text })

  const json = await queryGallery({
    filters: [{ criteria, pageNumber: 1, pageSize: Math.min(pageSize * 2, 50), sortBy: 4, sortOrder: 0 }],
    flags: 772,
  })

  const results = json?.results as { extensions?: Record<string, unknown>[] }[] | undefined
  const extensions = results?.[0]?.extensions ?? []

  return extensions
    .filter(ext => !looksLikeIconTheme(ext))
    .slice(0, pageSize)
    .map(ext => {
      const pub = ext.publisher as Record<string, unknown> | undefined
      const stats = ext.statistics as { statisticName: string; value: number }[] | undefined
      const installStat = stats?.find(s => s.statisticName === 'install')
      const publisherName = String(pub?.publisherName ?? '')
      return {
        extensionId: `${publisherName}.${ext.extensionName}`,
        displayName: String(ext.displayName || ext.extensionName || ''),
        publisher: String(pub?.displayName || publisherName),
        description: String(ext.shortDescription || ''),
        installs: Math.round(installStat?.value ?? 0),
      }
    })
}

function readU16LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8)
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0
}

function textDecoder(buf: Uint8Array, start: number, end: number): string {
  return new TextDecoder().decode(buf.subarray(start, end))
}

type ZipRecord = { method: number; compressedSize: number; localOffset: number }

function readCentralDirectory(buf: Uint8Array): Map<string, ZipRecord> {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (readU32LE(buf, i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd === -1) throw new Error('Not a valid zip archive.')

  const count = readU16LE(buf, eocd + 10)
  let offset = readU32LE(buf, eocd + 16)
  const records = new Map<string, ZipRecord>()

  for (let i = 0; i < count; i++) {
    if (readU32LE(buf, offset) !== 0x02014b50) break
    const method = readU16LE(buf, offset + 10)
    const compressedSize = readU32LE(buf, offset + 20)
    const nameLen = readU16LE(buf, offset + 28)
    const extraLen = readU16LE(buf, offset + 30)
    const commentLen = readU16LE(buf, offset + 32)
    const localOffset = readU32LE(buf, offset + 42)
    const name = textDecoder(buf, offset + 46, offset + 46 + nameLen)
    records.set(name, { method, compressedSize, localOffset })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return records
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const writer = ds.writable.getWriter()
  void writer.write(data as unknown as BufferSource)
  void writer.close()
  const reader = ds.readable.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const result = new Uint8Array(total)
  let pos = 0
  for (const chunk of chunks) { result.set(chunk, pos); pos += chunk.length }
  return result
}

async function extractEntry(buf: Uint8Array, record: ZipRecord): Promise<string> {
  if (readU32LE(buf, record.localOffset) !== 0x04034b50) {
    throw new Error('Corrupt zip: bad local file header.')
  }
  const nameLen = readU16LE(buf, record.localOffset + 26)
  const extraLen = readU16LE(buf, record.localOffset + 28)
  const dataStart = record.localOffset + 30 + nameLen + extraLen
  const data = buf.subarray(dataStart, dataStart + record.compressedSize)

  if (record.method === 0) return textDecoder(data, 0, data.length)
  const inflated = await inflateRaw(data)
  return textDecoder(inflated, 0, inflated.length)
}

export async function fetchMarketplace(id: string): Promise<DesktopMarketplaceThemeResult> {
  const trimmed = String(id || '').trim()
  if (!ID_RE.test(trimmed)) throw new Error('Expected a Marketplace id like "publisher.extension".')

  const json = await queryGallery({
    filters: [{ criteria: [{ filterType: 7, value: trimmed }], pageNumber: 1, pageSize: 1 }],
    flags: 914,
  })

  const results = json?.results as { extensions?: Record<string, unknown>[] }[] | undefined
  const extension = results?.[0]?.extensions?.[0]
  if (!extension) throw new Error(`Extension "${trimmed}" was not found on the Marketplace.`)

  const versions = extension.versions as { files?: { assetType: string; source: string }[] }[] | undefined
  const version = versions?.[0]
  if (!version) throw new Error(`Extension "${trimmed}" has no published versions.`)

  const asset = version.files?.find(f => f.assetType === VSIX_ASSET_TYPE)
  if (!asset?.source) throw new Error(`Could not find a downloadable package for "${trimmed}".`)

  const displayName = String(extension.displayName || trimmed)

  const response = await fetch(asset.source)
  if (!response.ok) throw new Error(`Failed to download VSIX (${response.status}).`)
  const arrayBuf = await response.arrayBuffer()
  if (arrayBuf.byteLength > MAX_VSIX_BYTES) throw new Error('VSIX exceeds the size limit.')

  const vsix = new Uint8Array(arrayBuf)
  const records = readCentralDirectory(vsix)
  const pkgRecord = records.get('extension/package.json')
  if (!pkgRecord) throw new Error('Package manifest missing from the extension.')

  const pkg = JSON.parse(await extractEntry(vsix, pkgRecord)) as {
    contributes?: { themes?: { path?: string; label?: string; id?: string; uiTheme?: string }[] }
    displayName?: string; name?: string
  }
  const contributed = pkg?.contributes?.themes
  if (!Array.isArray(contributed) || contributed.length === 0) {
    return { extensionId: trimmed, displayName, themes: [] }
  }

  const themes: DesktopMarketplaceThemeFile[] = []
  for (const entry of contributed) {
    if (!entry?.path) continue
    const entryName = 'extension/' + entry.path.replace(/^\.\//, '').replace(/^\//, '')
    const rec = records.get(entryName)
    if (!rec) continue
    try {
      themes.push({
        label: entry.label || entry.id || pkg.displayName || pkg.name || 'VS Code Theme',
        uiTheme: entry.uiTheme,
        contents: await extractEntry(vsix, rec),
      })
    } catch { /* skip corrupt entry */ }
  }

  return { extensionId: trimmed, displayName, themes }
}
