const APP_GROUP_KEY = 'hermes-mobile-pending-share'

interface SharedPayload {
  texts: string[]
  urls: string[]
  images: string[]
  userText: string
  timestamp: number
}

export function consumePendingShare(): SharedPayload | null {
  try {
    const raw = localStorage.getItem(APP_GROUP_KEY)
    if (!raw) return null
    localStorage.removeItem(APP_GROUP_KEY)
    return JSON.parse(raw) as SharedPayload
  } catch {
    return null
  }
}

export function composerInsertText(text: string): void {
  const composer = document.querySelector<HTMLElement>('[data-slot="composer-rich-input"]')
  if (!composer) return

  composer.focus()
  const selection = window.getSelection()
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0)
    range.deleteContents()
    range.insertNode(document.createTextNode(text))
    range.collapse(false)
  } else {
    composer.textContent = (composer.textContent ?? '') + text
  }

  composer.dispatchEvent(new Event('input', { bubbles: true }))
}

export function handleShareDeepLink(): void {
  const payload = consumePendingShare()
  if (!payload) return

  const parts: string[] = []

  if (payload.userText) parts.push(payload.userText)

  for (const url of payload.urls) {
    parts.push(url)
  }

  for (const text of payload.texts) {
    if (!parts.includes(text)) parts.push(text)
  }

  if (parts.length > 0) {
    setTimeout(() => composerInsertText(parts.join('\n\n')), 500)
  }
}
