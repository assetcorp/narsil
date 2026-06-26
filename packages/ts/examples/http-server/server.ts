import { createNarsil, type Narsil } from '@delali/narsil'
import { createServer, type OnRequestHook, type ServerLimits } from '@delali/narsil/server'

/**
 * Standalone Narsil HTTP server. Builds one engine, wraps it with the HTTP layer,
 * and runs until it receives SIGTERM or SIGINT. Configuration is read from the
 * environment so the same image runs locally and in a container. This is the node
 * entrypoint the distributed phase builds on.
 *
 * Environment:
 *   NARSIL_HOST              listen address           (default 0.0.0.0)
 *   NARSIL_PORT              listen port              (default 7700)
 *   NARSIL_DURABILITY_DIR    enable filesystem durability rooted at this path
 *   NARSIL_API_KEY           require this bearer token / x-api-key when set
 *   NARSIL_MAX_BODY_BYTES    JSON body cap            (default 16 MiB)
 *   NARSIL_MAX_IMPORT_BYTES  NDJSON / restore cap     (default 100 MiB)
 *   NARSIL_MAX_CONCURRENT    in-flight request cap    (default unbounded)
 */

function intFromEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer, got "${raw}"`)
  }
  return value
}

function buildLimits(): ServerLimits {
  const limits: ServerLimits = {}
  const maxBody = intFromEnv('NARSIL_MAX_BODY_BYTES')
  const maxImport = intFromEnv('NARSIL_MAX_IMPORT_BYTES')
  const maxConcurrent = intFromEnv('NARSIL_MAX_CONCURRENT')
  if (maxBody !== undefined) limits.maxBodyBytes = maxBody
  if (maxImport !== undefined) limits.maxImportBytes = maxImport
  if (maxConcurrent !== undefined) limits.maxConcurrentRequests = maxConcurrent
  return limits
}

function buildAuthHook(): OnRequestHook | undefined {
  const apiKey = process.env.NARSIL_API_KEY
  if (!apiKey || apiKey.length === 0) return undefined
  return ctx => {
    const header = ctx.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    const presented = bearer ?? ctx.headers['x-api-key']
    if (presented === apiKey) return undefined
    return { status: 401, code: 'UNAUTHORIZED', message: 'A valid API key is required' }
  }
}

async function buildEngine(): Promise<Narsil> {
  const directory = process.env.NARSIL_DURABILITY_DIR
  if (directory && directory.length > 0) {
    return createNarsil({ durability: { directory } })
  }
  return createNarsil()
}

async function main(): Promise<void> {
  const host = process.env.NARSIL_HOST ?? '0.0.0.0'
  const port = intFromEnv('NARSIL_PORT') ?? 7700

  const engine = await buildEngine()
  const server = createServer(engine, {
    host,
    port,
    onRequest: buildAuthHook(),
    limits: buildLimits(),
  })

  await server.listen()
  console.log(`Narsil HTTP server listening on http://${host}:${server.listeningPort}`)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`Received ${signal}, shutting down`)
    let exitCode = 0
    try {
      await server.close()
    } catch (err) {
      exitCode = 1
      console.error('Failed to close the HTTP server cleanly:', err)
    }
    try {
      await engine.shutdown()
    } catch (err) {
      exitCode = 1
      console.error('Failed to shut down the engine cleanly:', err)
    }
    process.exit(exitCode)
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

main().catch(err => {
  console.error('Narsil HTTP server failed to start:', err)
  process.exit(1)
})
