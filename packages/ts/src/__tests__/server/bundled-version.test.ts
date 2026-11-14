import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { version } from '../../../package.json'
import { createNarsil } from '../../narsil'
import type { createServer } from '../../server'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(join(PACKAGE_ROOT, 'package.json'))

it('reports the package version when an application bundles the server away from its manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-bundled-version-'))
  const engine = await createNarsil({ workers: { enabled: false } })
  try {
    const output = join(directory, 'application.mjs')
    await build({
      entryPoints: [join(PACKAGE_ROOT, 'dist', 'server.mjs')],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      plugins: [
        {
          name: 'installed-dependencies',
          setup(builder) {
            builder.onResolve({ filter: /^[@a-zA-Z]/ }, args => ({
              path: args.path.startsWith('node:') ? args.path : require.resolve(args.path),
              external: true,
            }))
          },
        },
      ],
    })
    const bundled = (await import(pathToFileURL(output).href)) as { createServer: typeof createServer }
    const server = bundled.createServer(engine, { host: '127.0.0.1', port: 0 })
    try {
      await server.listen()
      const response = await fetch(`http://127.0.0.1:${server.listeningPort}/version`)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ version, gitSha: null, dirty: false })
    } finally {
      await server.close()
    }
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
