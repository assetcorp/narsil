import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const scenario = fileURLToPath(new URL('./browser-search-state.mjs', import.meta.url))

it('keeps the browser search count, facets, and documents in its first state while a write arrives', async () => {
  const { stdout } = await execute(process.execPath, ['--conditions=browser', scenario], { timeout: 30_000 })
  expect(JSON.parse(stdout)).toEqual({
    writeStartedDuringSearch: true,
    otherIndexFinishedDuringSearch: true,
    vectorWriteStartedDuringSearch: true,
    vectorHits: 10_000,
    scoreMismatches: 0,
    count: 32_000,
    earlierFacet: 32_000,
    laterFacet: 0,
    earlierDocument: true,
    laterDocumentStored: true,
    heldAfter: 0,
    partialIds: ['independent'],
    synonymIds: ['independent'],
  })
}, 35_000)
