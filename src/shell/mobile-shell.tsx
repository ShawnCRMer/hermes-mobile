import { useState, useCallback, useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import { SidebarProvider } from '@/components/ui/sidebar'
import { ContribWiring, WiredPane } from '@/app/contrib'
import { TabBar, type TabId } from './tab-bar'
import { SettingsTab } from './settings-tab'
import { LocalModelBar } from './local-model-bar'

export function MobileShell() {
  const [activeTab, setActiveTab] = useState<TabId>('chat')
  const location = useLocation()
  const prevPathRef = useRef(location.pathname)

  // When a session is selected from the Sessions tab, the sidebar navigates
  // to /:sessionId. Detect this and auto-switch to the Chat tab.
  useEffect(() => {
    const prev = prevPathRef.current
    prevPathRef.current = location.pathname

    if (activeTab !== 'sessions') return
    // A path change from / or /new to a session ID means the user tapped a session
    if (location.pathname !== prev && location.pathname.length > 1 && !location.pathname.startsWith('/settings')) {
      setActiveTab('chat')
    }
  }, [location.pathname, activeTab])

  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab)
  }, [])

  return (
    <SidebarProvider open={true} style={{ '--sidebar-width': '100%' } as React.CSSProperties}>
    <ContribWiring>
      <div className="mobile-shell">
        <div className="mobile-shell__content">
          {/* Chat and Sessions stay mounted for react-router state preservation.
              Only the active pane is visible; others are hidden but not unmounted. */}
          <div className="mobile-shell__pane mobile-shell__pane--chat" data-visible={activeTab === 'chat' || undefined} aria-hidden={activeTab !== 'chat'}>
            <LocalModelBar />
            <div className="mobile-shell__chat-fill">
              <WiredPane part="chatRoutes" />
            </div>
          </div>
          <div className="mobile-shell__pane" data-visible={activeTab === 'sessions' || undefined} aria-hidden={activeTab !== 'sessions'}>
            <WiredPane part="sidebar" />
          </div>
          {activeTab === 'settings' && (
            <div className="mobile-shell__pane" data-visible aria-hidden={false}>
              <SettingsTab />
            </div>
          )}
        </div>
        <TabBar activeTab={activeTab} onTabChange={handleTabChange} />
      </div>
    </ContribWiring>
    </SidebarProvider>
  )
}
