import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router'
import {
  isLocalEnabled,
  isLocalModeAvailable,
  getLocalState,
  onLocalProgress,
  type LocalGatewayState,
} from '../bridge/local-connection'
import { openSheet as openModelManager } from '../bridge/model-manager-ui'
import type { DesktopConnectionsRegistry, DesktopRegistryConnection } from '@/global'

const SHELL_KEY = 'hermes:shell'

function ConnectionIcon({ kind }: { kind: string }) {
  if (kind === 'local') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
        <rect x="9" y="9" width="6" height="6" />
        <line x1="9" y1="1" x2="9" y2="4" />
        <line x1="15" y1="1" x2="15" y2="4" />
        <line x1="9" y1="20" x2="9" y2="23" />
        <line x1="15" y1="20" x2="15" y2="23" />
        <line x1="20" y1="9" x2="23" y2="9" />
        <line x1="20" y1="14" x2="23" y2="14" />
        <line x1="1" y1="9" x2="4" y2="9" />
        <line x1="1" y1="14" x2="4" y2="14" />
      </svg>
    )
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  )
}

function phaseLabel(phase: LocalGatewayState['phase']): string {
  switch (phase) {
    case 'idle': return 'Idle'
    case 'interpreter': return 'Starting Python...'
    case 'imports': return 'Loading modules...'
    case 'bind': return 'Binding server...'
    case 'ready': return 'Running'
    case 'error': return 'Error'
  }
}

export function SettingsTab() {
  const navigate = useNavigate()
  const [registry, setRegistry] = useState<DesktopConnectionsRegistry | null>(null)
  const [localOn, setLocalOn] = useState(isLocalEnabled())
  const [localPhase, setLocalPhase] = useState(getLocalState().phase)
  const localAvailable = isLocalModeAvailable()

  useEffect(() => {
    window.hermesDesktop?.connections.list().then(setRegistry).catch(() => {})
    return onLocalProgress(state => {
      setLocalOn(state.enabled)
      setLocalPhase(state.phase)
    })
  }, [])

  const handleSwitch = useCallback(async (entry: DesktopRegistryConnection) => {
    if (entry.kind === 'local') {
      await window.hermesDesktop?.applyConnectionConfig({ mode: 'local' })
    } else {
      await window.hermesDesktop?.applyConnectionConfig({
        mode: 'remote',
        remoteUrl: entry.url,
        remoteAuthMode: entry.authMode,
      })
    }
  }, [])

  const handleOgToggle = useCallback(() => {
    try {
      const current = localStorage.getItem(SHELL_KEY)
      localStorage.setItem(SHELL_KEY, current === 'desktop' ? 'mobile' : 'desktop')
    } catch { /* private browsing */ }
    setTimeout(() => window.location.reload(), 50)
  }, [])

  const handleOpenModelManager = useCallback(() => {
    openModelManager()
  }, [])

  const handleOpenSettings = useCallback(() => {
    navigate('/settings')
  }, [navigate])

  const isOgMode = (() => {
    try { return localStorage.getItem(SHELL_KEY) === 'desktop' } catch { return false }
  })()

  const activeConnectionId = localOn ? 'local' : registry?.primary ?? null

  const connections: DesktopRegistryConnection[] = registry?.connections ?? []

  return (
    <div className="mobile-settings">
      <div className="mobile-settings__header">
        <h1>Settings</h1>
      </div>

      <div className="mobile-settings__scroll">
        {/* Connection Switcher */}
        <section className="mobile-settings__section">
          <h2 className="mobile-settings__section-title">Gateway</h2>
          <div className="mobile-settings__card-group">
            {connections.map(entry => (
              <button
                key={entry.id}
                className="mobile-settings__connection"
                data-active={entry.id === activeConnectionId}
                onClick={() => handleSwitch(entry)}
              >
                <ConnectionIcon kind={entry.kind} />
                <div className="mobile-settings__connection-info">
                  <span className="mobile-settings__connection-label">{entry.label}</span>
                  <span className="mobile-settings__connection-detail">
                    {entry.kind === 'local'
                      ? phaseLabel(localPhase)
                      : entry.url || entry.kind}
                  </span>
                </div>
                {entry.id === activeConnectionId && (
                  <svg className="mobile-settings__check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </section>

        {/* Model Manager */}
        {localAvailable && (
          <section className="mobile-settings__section">
            <h2 className="mobile-settings__section-title">On-Device Models</h2>
            <div className="mobile-settings__card-group">
              <button className="mobile-settings__action-row" onClick={handleOpenModelManager}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                  <line x1="12" y1="22.08" x2="12" y2="12" />
                </svg>
                <span>Manage Models</span>
                <svg className="mobile-settings__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          </section>
        )}

        {/* Advanced Settings */}
        <section className="mobile-settings__section">
          <h2 className="mobile-settings__section-title">Advanced</h2>
          <div className="mobile-settings__card-group">
            <button className="mobile-settings__action-row" onClick={handleOpenSettings}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>All Settings</span>
              <svg className="mobile-settings__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        </section>

        {/* Display Mode */}
        <section className="mobile-settings__section">
          <h2 className="mobile-settings__section-title">Display</h2>
          <div className="mobile-settings__card-group">
            <button className="mobile-settings__action-row" onClick={handleOgToggle}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <span>{isOgMode ? 'Switch to Mobile Layout' : 'Switch to Desktop Layout'}</span>
              <svg className="mobile-settings__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
