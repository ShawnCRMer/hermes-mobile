import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '../upstream/apps/desktop/src')
const contractPath = path.join(root, 'global.d.ts')
const manifestPath = path.resolve(import.meta.dirname, '../src/bridge/manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const methods = manifest.methods
const validStatuses = new Set(['impl', 'stub', 'omit', 'n/a'])

function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return filesIn(full)
    if (!/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) return []
    if (/\.(?:test|spec)\./.test(entry.name)) return []
    return [full]
  })
}

const sourceMethods = new Map()
const usage = new Map()
const contract = fs.readFileSync(contractPath, 'utf8')
const bridgeBlock = contract.match(/interface Window[\s\S]*?hermesDesktop:\s*\{([\s\S]*?)^    \}\s*^  \}/m)?.[1] ?? ''

for (const match of bridgeBlock.matchAll(/^      ([A-Za-z_$][A-Za-z0-9_$]*)(\?)?[:(]/gm)) {
  sourceMethods.set(match[1], !match[2])
}

for (const file of filesIn(root)) {
  const text = fs.readFileSync(file, 'utf8')
  for (const match of text.matchAll(/window\.hermesDesktop(\?\.)?\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    const name = match[2]
    const list = usage.get(name) ?? []
    list.push(path.relative(root, file))
    usage.set(name, list)
  }
}

const errors = []
for (const [name, required] of sourceMethods) {
  if (required && !methods[name]) errors.push('required contract method missing from manifest: ' + name)
}
for (const [name, files] of usage) {
  if (!methods[name]) errors.push('renderer usage missing from manifest: ' + name + ' (' + files.join(', ') + ')')
}
for (const [name, entry] of Object.entries(methods)) {
  if (typeof entry === 'string') {
    if (!validStatuses.has(entry)) errors.push('invalid status for ' + name + ': ' + entry)
  } else if (typeof entry === 'object' && entry !== null) {
    for (const [col, status] of Object.entries(entry)) {
      if (!validStatuses.has(status)) errors.push('invalid status for ' + name + '.' + col + ': ' + status)
    }
  }
}

const report = {
  upstreamSha: manifest.upstreamSha,
  required: [...sourceMethods].filter(([, required]) => required).map(([name]) => name).sort(),
  usage: [...usage.keys()].sort(),
  methods,
}
console.log(JSON.stringify(report, null, 2))

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
}
