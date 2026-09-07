import path from 'node:path'

import { defineConfig, mergeConfig, type ConfigEnv } from 'vite'

import upstream from './upstream/apps/desktop/vite.config'

const UP = path.resolve(__dirname, 'upstream/apps/desktop')

const gatewayTarget = process.env.HERMES_GATEWAY_URL || 'http://127.0.0.1:9119'

export default defineConfig(async (env: ConfigEnv) => {
  const base = typeof upstream === 'function' ? await upstream(env) : upstream

  return mergeConfig(base, {
    root: __dirname,
    publicDir: path.resolve(UP, 'public'),
    build: {
      outDir: path.resolve(__dirname, 'dist'),
      emptyOutDir: true
    },
    server: {
      host: '0.0.0.0',
      port: 5175,
      strictPort: true,
      fs: {
        allow: [__dirname, UP, path.resolve(UP, '../..')]
      },
      proxy: {
        '/api/ws': { target: gatewayTarget, ws: true, changeOrigin: true },
        '/api': { target: gatewayTarget, changeOrigin: true },
      }
    },
    preview: {
      host: '127.0.0.1',
      port: 4175,
      strictPort: true,
      proxy: {
        '/api/ws': { target: gatewayTarget, ws: true, changeOrigin: true },
        '/api': { target: gatewayTarget, changeOrigin: true },
      }
    },
    resolve: {
      alias: {
        '@upstream': path.resolve(UP, 'src')
      }
    }
  })
})
