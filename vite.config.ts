import path from 'node:path'

import { defineConfig, mergeConfig, type ConfigEnv } from 'vite'

import upstream from './upstream/apps/desktop/vite.config'

const UP = path.resolve(__dirname, 'upstream/apps/desktop')

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
      }
    },
    preview: {
      host: '127.0.0.1',
      port: 4175,
      strictPort: true
    },
    resolve: {
      alias: {
        '@upstream': path.resolve(UP, 'src')
      }
    }
  })
})
