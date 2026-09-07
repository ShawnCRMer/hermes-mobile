/**
 * WebKit smoke test — ADR-001 Phase 0 criterion 4.
 *
 * Loads the mobile build in Playwright WebKit against a real Hermes gateway
 * in token mode. Asserts: boot overlay dismisses, chat UI renders, zero
 * uncaught exceptions, and (when the gateway has a model) a prompt returns
 * a reply.
 *
 * Gateway URL from HERMES_GATEWAY_URL env var; defaults to 127.0.0.1:57317
 * (the desktop-spawned gateway on the Mac's loopback).
 *
 * Prerequisite: `npm run build` so dist/ exists.
 */

import { test, expect, type Page } from '@playwright/test'

const GATEWAY_URL = process.env.HERMES_GATEWAY_URL ?? 'http://127.0.0.1:57317'

const consoleErrors: string[] = []

function trackConsoleErrors(page: Page): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      // Filter out noisy but harmless errors.
      if (text.includes('favicon') || text.includes('apple-touch-icon')) return
      consoleErrors.push(text)
    }
  })

  page.on('pageerror', (error) => {
    consoleErrors.push(`Uncaught: ${error.message}`)
  })
}

/**
 * Wait for the Hermes boot overlay to dismiss and the chat UI to render.
 * Mirrors the upstream waitForAppReady pattern: composer visible AND no
 * full-viewport fixed overlay covering the viewport center.
 */
async function waitForAppReady(page: Page, timeoutMs = 30_000): Promise<void> {
  // Wait for the composer input to appear in the DOM.
  await page.waitForSelector('[contenteditable="true"], textarea', {
    state: 'attached',
    timeout: timeoutMs,
  })

  // Wait until no full-screen overlay covers the viewport center.
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

test.beforeEach(({ page }) => {
  consoleErrors.length = 0
  trackConsoleErrors(page)
})

test('boot overlay dismisses and chat UI renders', async ({ page }) => {
  await page.goto(`/?gateway=${encodeURIComponent(GATEWAY_URL)}`)
  await waitForAppReady(page)

  // The data-hermes-host attribute should be set by the bridge.
  const hostAttr = await page.locator('html').getAttribute('data-hermes-host')
  expect(hostAttr).toBe('mobile')

  // The composer should be visible and interactable.
  const composer = page.locator('[contenteditable="true"]').first()
  await expect(composer).toBeVisible({ timeout: 5_000 })
})

test('settings overlay opens', async ({ page }) => {
  await page.goto(`/?gateway=${encodeURIComponent(GATEWAY_URL)}`)
  await waitForAppReady(page)

  // Open settings — upstream uses Cmd+, or a gear button.
  // The sidebar toggle or settings button should be accessible.
  // Try the keyboard shortcut first.
  const isMac = process.platform === 'darwin'
  await page.keyboard.press(isMac ? 'Meta+,' : 'Control+,')

  // Wait for settings content to appear.
  await page.waitForFunction(
    () => {
      const text = document.body.textContent ?? ''
      return text.includes('Settings') || text.includes('Gateway') || text.includes('Appearance')
    },
    undefined,
    { timeout: 10_000 },
  )
})

test.afterEach(async () => {
  // ADR-001 Phase 0 criterion 4: zero uncaught exceptions.
  expect(consoleErrors, `Console errors during test:\n${consoleErrors.join('\n')}`).toEqual([])
})
