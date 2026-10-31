import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedLimits } from '../../src/server/deps'
import { serverRoutes } from '../../src/server/routes'
import { assertEveryRouteDescribed, buildOpenApiDocument } from './document'

const PACKAGE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUTPUT_PATH = join(PACKAGE_DIRECTORY, 'openapi.json')
const WRITE_HINT = 'Run "pnpm nx run narsil-ts:openapi:write" to regenerate it.'
const LIMITS_THAT_DO_NOT_REACH_THE_FILE: ResolvedLimits = {
  maxBodyBytes: 0,
  maxImportBytes: 0,
  maxRestoreBytes: 0,
  maxLineBytes: 0,
  importBatchSize: 0,
  maxConcurrentRequests: 0,
  maxBodyBytesInFlight: 0,
  maxResultWindow: 0,
  maxRerankWindow: 0,
  maxFetchDocuments: 0,
  maxImportErrors: 0,
  maxTaskPageSize: 0,
  maxConcurrentTasks: 0,
}

function run(write: boolean): number {
  const routes = serverRoutes(LIMITS_THAT_DO_NOT_REACH_THE_FILE)
  const generated = `${JSON.stringify(buildOpenApiDocument(routes, PACKAGE_DIRECTORY), null, 2)}\n`
  if (write) {
    writeFileSync(OUTPUT_PATH, generated)
    console.log(`Wrote ${OUTPUT_PATH} with ${routes.length} operations`)
    return 0
  }
  const committed = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, 'utf-8') : '{}'
  assertEveryRouteDescribed(routes, JSON.parse(committed))
  if (committed !== generated) {
    console.error(`openapi.json differs from a fresh generation. ${WRITE_HINT}`)
    return 1
  }
  console.log(`openapi.json matches a fresh generation of ${routes.length} operations`)
  return 0
}

process.exitCode = run(process.argv.includes('--write'))
