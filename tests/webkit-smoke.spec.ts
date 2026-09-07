/**
 * WebKit smoke test — ADR-001 Phase 0 criterion 4.
 *
 * Loads the mobile build in Playwright WebKit against a real Hermes gateway
 * in token mode. Asserts: boot overlay dismisses, chat UI renders, zero
 * uncaught exceptions, and settings overlay opens.
 *
 * The preview server proxies /api and /api/ws to the gateway (configured via
 * HERMES_GATEWAY_URL env var, defaults to 127.0.0.1:9119).
 *
 * The session token is read from HERMES_SESSION_TOKEN env var or scraped from
 * the gateway's root page, then injected via window.__HERMES_MOBILE_CONFIG__.
 *
 * Prerequisite: `npm run build` so dist/ exists.
 */

import { test, expect, type Page } from '@playwright/test'

const GATEWAY_URL = process.env.HERMES_GATEWAY_URL ?? 'http://127.0.0.1:9119'

const consoleErrors: string[] = []

const NOISE = [
  'favicon', 'apple-touch-icon',
  'Failed to load resource',
]

function trackConsoleErrors(page: Page): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      if (NOISE.some(n => text.includes(n))) return
      consoleErrors.push(text)
    }
  })

  page.on('pageerror', (error) => {
    consoleErrors.push(`Uncaught: ${error.message}`)
  })
}

async function waitForAppReady(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForSelector('[contenteditable="true"], textarea', {
    state: 'attached',
    timeout: timeoutMs,
  })

  await page.waitForFunction(
    () => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
      if (!el) return false
      let node: Element | null = el
      while (node) {
        const cs = window.getComputedStyle(node)
        if (cs.position === 'fixed') {
          const rect = node.getBoundingClientRect()
          if (
            rect.left <= 0 &&
            rect.top <= 0 &&
            rect.right >= window.innerWidth &&
            rect.bottom >= window.innerHeight
          ) {
            return false
          }
        }
        node = node.parentElement
      }
      return true
    },
    undefined,
    { timeout: timeoutMs },
  )
}

let sessionToken = ''

test.beforeAll(async ({ request }) => {
  if (process.env.HERMES_SESSION_TOKEN) {
    sessionToken = process.env.HERMES_SESSION_TOKEN
    return
  }
  const response = await request.get(GATEWAY_URL + '/')
  const html = await response.text()
  const match = /window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]*)"/.exec(html)
  sessionToken = match?.[1] ?? ''
})

test.beforeEach(async ({ page }) => {
  consoleErrors.length = 0
  trackConsoleErrors(page)
  if (sessionToken) {
    await page.addInitScript((token: string) => {
      window.__HERMES_MOBILE_CONFIG__ = { token }
    }, sessionToken)
  }
})

test('boot overlay dismisses and chat UI renders', async ({ page }) => {
  await page.goto('/')
  await waitForAppReady(page)

  const hostAttr = await page.locator('html').getAttribute('data-hermes-host')
  expect(hostAttr).toBe('mobile')

  const composer = page.locator('[contenteditable="true"]').first()
  await expect(composer).toBeVisible({ timeout: 5_000 })
})

test('settings overlay opens', async ({ page }) => {
  await page.goto('/')
  await waitForAppReady(page)

  const isMac = process.platform === 'darwin'
  await page.keyboard.press(isMac ? 'Meta+,' : 'Control+,')

  await page.waitForFunction(
    () => {
      const text = document.body.textContent ?? ''
      return text.includes('Settings') || text.includes('Gateway') || text.includes('Appearance')
    },
    undefined,
    { timeout: 10_000 },
  )
})

test('mobile viewport 390x844 — composer visible, no notch overlap', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const url = sessionToken ? `/?token=${encodeURIComponent(sessionToken)}` : '/'
  await page.goto(url)
  await waitForAppReady(page)

  const composer = page.locator('[contenteditable="true"]').first()
  await expect(composer).toBeVisible({ timeout: 5_000 })
  const box = await composer.boundingBox()
  expect(box).toBeTruthy()
  expect(box!.y + box!.height).toBeLessThan(844)
})

test.afterEach(async () => {
  expect(consoleErrors, `Console errors during test:\n${consoleErrors.join('\n')}`).toEqual([])
})
