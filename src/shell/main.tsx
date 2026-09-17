// Mobile shell entry point — replaces upstream/main.tsx when in mobile layout mode.
// Replicates the upstream provider stack but mounts MobileShell instead of ContribController.
import '@upstream/styles.css'
// Side-effect: reports in-flight turns so the quit guard (and gateway shutdown) know about active work.
import '@upstream/store/active-work'

import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'

import { RootErrorBoundary } from '@/components/error-boundary'
import { HapticsProvider } from '@/components/haptics-provider'
import { RootTooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { installRendererAnimationPauseState } from '@/lib/renderer-loop-pause'
import { ThemeProvider } from '@/themes/context'

import { MobileShell } from './mobile-shell'

installRendererAnimationPauseState()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ThemeProvider>
            <HapticsProvider>
              <RootTooltipProvider>
                <HashRouter useTransitions={false}>
                  <MobileShell />
                </HashRouter>
              </RootTooltipProvider>
            </HapticsProvider>
          </ThemeProvider>
        </I18nProvider>
      </QueryClientProvider>
    </RootErrorBoundary>
  </StrictMode>
)
