import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.mobilehermes.app',
  appName: 'Hermes',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // For live reload during development, uncomment and set your Mac's IP:
    // url: 'http://<your-ip>:5175',
    // cleartext: true,
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: '#0a84ff',
    },
  },
  ios: {
    scheme: 'Hermes',
  },
  packageClassList: [
    'SecureStorage',
    'AppPlugin',
    'DevicePlugin',
    'FilesystemPlugin',
    'HapticsPlugin',
    'LocalNotificationsPlugin',
    'CAPNetworkPlugin',
    'SharePlugin',
    'StatusBarPlugin',
    'OAuthPlugin',
    'ModelManagerPlugin',
    'LocalGatewayPlugin',
  ],
}

export default config
