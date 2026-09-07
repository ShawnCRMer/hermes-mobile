/// <reference types="vite/client" />

declare module '@upstream/main.tsx' {}

declare global {
  interface HermesMobileRuntimeConfig {
    gatewayUrl?: string
    token?: string
  }

  interface Window {
    __HERMES_MOBILE_CONFIG__?: HermesMobileRuntimeConfig
  }
}

export {}
