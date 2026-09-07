import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.hermesmobile.app',
  appName: 'Hermes',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // For live reload during development, uncomment and set your Mac's IP:
    // url: 'http://<your-ip>:5175',
    // cleartext: true,
  }
}

export default config
