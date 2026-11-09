import { defineConfig } from 'vitest/config'
import { transformSync } from 'esbuild'

export default defineConfig({
  plugins: [
    {
      name: 'standard-decorators',
      enforce: 'pre',
      transform(code, id) {
        const file = id.split('?')[0]!
        if (!/\.[cm]?tsx?$/.test(file) || !/^\s*@[A-Za-z_$][\w$]*/m.test(code)) return
        const result = transformSync(code, {
          sourcefile: file,
          loader: file.endsWith('x') ? 'tsx' : 'ts',
          target: 'es2024',
          format: 'esm',
          sourcemap: 'external',
          tsconfigRaw: { compilerOptions: { experimentalDecorators: false } },
        })
        return {
          code: result.code,
          map: result.map,
        }
      },
    },
  ],
  test: { include: ['tests/**/*.spec.{ts,tsx}'], exclude: ['tests/**/*.e2e.ts'] },
})
