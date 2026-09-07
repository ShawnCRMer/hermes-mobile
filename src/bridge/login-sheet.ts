export type LoginCredentials = { username: string; password: string }

const SHEET_ID = 'hermes-mobile-login-sheet'

const SHEET_STYLES = `
  #${SHEET_ID} {
    position: fixed; inset: 0; z-index: 99999;
    display: flex; align-items: flex-end; justify-content: center;
    background: rgba(0,0,0,0.45);
    font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
    opacity: 0; transition: opacity 0.2s ease;
  }
  #${SHEET_ID}.visible { opacity: 1; }
  #${SHEET_ID} .sheet {
    width: 100%; max-width: 420px;
    background: var(--card-background, #1c1c1e);
    border-radius: 16px 16px 0 0;
    padding: 24px 20px calc(20px + env(safe-area-inset-bottom));
    transform: translateY(100%); transition: transform 0.3s cubic-bezier(0.32,0.72,0,1);
    color: var(--foreground, #f5f5f5);
  }
  #${SHEET_ID}.visible .sheet { transform: translateY(0); }
  #${SHEET_ID} .sheet-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 20px;
  }
  #${SHEET_ID} .sheet-title { font-size: 17px; font-weight: 600; }
  #${SHEET_ID} .sheet-cancel {
    font-size: 15px; color: #0a84ff; background: none; border: none;
    padding: 8px; margin: -8px; cursor: pointer; min-width: 44px; min-height: 44px;
    display: flex; align-items: center; justify-content: center;
  }
  #${SHEET_ID} .sheet-url {
    font-size: 13px; color: #8e8e93; margin-bottom: 16px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #${SHEET_ID} .field {
    display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px;
  }
  #${SHEET_ID} label { font-size: 13px; color: #8e8e93; }
  #${SHEET_ID} input[type="text"],
  #${SHEET_ID} input[type="password"] {
    width: 100%; box-sizing: border-box; padding: 12px 14px;
    font-size: 16px; line-height: 1.3;
    background: var(--input-background, #2c2c2e); color: inherit;
    border: 1px solid var(--input-border, #3a3a3c); border-radius: 10px;
    outline: none; -webkit-appearance: none;
  }
  #${SHEET_ID} input:focus {
    border-color: #0a84ff; box-shadow: 0 0 0 3px rgba(10,132,255,0.25);
  }
  #${SHEET_ID} .sheet-error {
    font-size: 13px; color: #ff453a; margin-bottom: 12px;
    min-height: 0; overflow: hidden;
  }
  #${SHEET_ID} .sheet-submit {
    width: 100%; padding: 14px; font-size: 17px; font-weight: 600;
    background: #0a84ff; color: #fff; border: none; border-radius: 12px;
    cursor: pointer; min-height: 50px; margin-top: 4px;
    transition: opacity 0.15s;
  }
  #${SHEET_ID} .sheet-submit:active { opacity: 0.7; }
  #${SHEET_ID} .sheet-submit:disabled { opacity: 0.4; cursor: default; }
`

export interface LoginSheet {
  readonly cancelled: Promise<void>
  setLoading(on: boolean): void
  setError(msg: string): void
  dismiss(): void
}

export function showLoginSheet(
  gatewayUrl: string,
  onSubmit: (credentials: LoginCredentials) => void,
): LoginSheet {
  const existing = document.getElementById(SHEET_ID)
  if (existing) existing.remove()

  const style = document.createElement('style')
  style.textContent = SHEET_STYLES

  let resolveCancelled: () => void
  const cancelled = new Promise<void>(r => { resolveCancelled = r })

  const overlay = document.createElement('div')
  overlay.id = SHEET_ID
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-header">
        <span class="sheet-title">Sign In</span>
        <button class="sheet-cancel" type="button">Cancel</button>
      </div>
      <div class="sheet-url"></div>
      <form autocomplete="on">
        <div class="field">
          <label for="hermes-login-user">Username</label>
          <input id="hermes-login-user" type="text" name="username"
                 autocomplete="username" autocapitalize="none" autocorrect="off"
                 spellcheck="false" required>
        </div>
        <div class="field">
          <label for="hermes-login-pass">Password</label>
          <input id="hermes-login-pass" type="password" name="password"
                 autocomplete="current-password" required>
        </div>
        <div class="sheet-error" role="alert"></div>
        <button class="sheet-submit" type="submit">Sign In</button>
      </form>
    </div>
  `

  const urlEl = overlay.querySelector('.sheet-url') as HTMLElement
  urlEl.textContent = gatewayUrl

  const form = overlay.querySelector('form')!
  const cancelBtn = overlay.querySelector('.sheet-cancel') as HTMLButtonElement
  const submitBtn = overlay.querySelector('.sheet-submit') as HTMLButtonElement
  const errorEl = overlay.querySelector('.sheet-error') as HTMLElement
  const userInput = overlay.querySelector('#hermes-login-user') as HTMLInputElement
  const passInput = overlay.querySelector('#hermes-login-pass') as HTMLInputElement

  function animateOut() {
    overlay.classList.remove('visible')
    overlay.addEventListener('transitionend', () => {
      overlay.remove()
      style.remove()
    }, { once: true })
  }

  function cancel() {
    animateOut()
    resolveCancelled()
  }

  cancelBtn.addEventListener('click', cancel)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cancel()
  })

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const username = userInput.value.trim()
    const password = passInput.value
    if (!username || !password) return
    onSubmit({ username, password })
  })

  document.head.appendChild(style)
  document.body.appendChild(overlay)
  requestAnimationFrame(() => {
    overlay.classList.add('visible')
    userInput.focus()
  })

  return {
    cancelled,
    setLoading(on: boolean) {
      submitBtn.disabled = on
      submitBtn.textContent = on ? 'Signing in…' : 'Sign In'
      userInput.disabled = on
      passInput.disabled = on
      cancelBtn.style.visibility = on ? 'hidden' : ''
      if (on) errorEl.textContent = ''
    },
    setError(msg: string) {
      errorEl.textContent = msg
      submitBtn.disabled = false
      submitBtn.textContent = 'Sign In'
      userInput.disabled = false
      passInput.disabled = false
      cancelBtn.style.visibility = ''
      passInput.value = ''
      passInput.focus()
    },
    dismiss: animateOut,
  }
}
