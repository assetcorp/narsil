import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers'

const SMALLEST_LIMIT = 1
const LARGEST_LIMIT_TEXT = '9007199254740991'
const OUT_OF_RANGE_LIMITS = ['0', '9007199254740992']
const SETTINGS = ['changes', 'sync'] as const
const LIMITS = ['historyMaxAgeMs', 'historyMaxBytes'] as const

interface Reply {
  status: number
  body: Record<string, unknown>
}

async function putSetting(base: string, index: string, setting: string, json: string): Promise<Reply> {
  const response = await fetch(`${base}/indexes/${index}/${setting}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: json,
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function readSetting(base: string, index: string, setting: string): Promise<string> {
  return await (await fetch(`${base}/indexes/${index}/${setting}`)).text()
}

describe('the history limits of the change capture and device sync settings over HTTP', () => {
  let directory = ''
  let running: TestServer | null = null

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-history-limits-'))
    running = await startTestServer({}, { durability: { directory }, workers: { enabled: false } })
    for (const setting of SETTINGS) {
      const created = await fetch(`${running.base}/indexes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `shop-${setting}`, config: { schema: { title: 'string' } } }),
      })
      expect(created.status, await created.text()).toBe(201)
    }
  })

  afterAll(async () => {
    await running?.stop()
    await rm(directory, { recursive: true, force: true })
  })

  for (const setting of SETTINGS) {
    for (const limit of LIMITS) {
      it(`admits ${limit} from 1 to 9,007,199,254,740,991 on the ${setting} setting and refuses 0 and the next integer`, async () => {
        if (running === null) throw new Error('the server never started')
        const index = `shop-${setting}`

        const smallest = await putSetting(running.base, index, setting, `{"enabled":true,"${limit}":${SMALLEST_LIMIT}}`)
        expect(smallest.status, JSON.stringify(smallest.body)).toBe(200)
        const largest = await putSetting(
          running.base,
          index,
          setting,
          `{"enabled":true,"${limit}":${LARGEST_LIMIT_TEXT}}`,
        )
        expect(largest.status, JSON.stringify(largest.body)).toBe(200)
        const admitted = await readSetting(running.base, index, setting)
        expect(admitted).toContain(`"${limit}":${LARGEST_LIMIT_TEXT}`)

        for (const value of OUT_OF_RANGE_LIMITS) {
          const refused = await putSetting(running.base, index, setting, `{"enabled":true,"${limit}":${value}}`)
          expect(refused.status, `${limit} ${value}: ${JSON.stringify(refused.body)}`).toBe(400)
          expect((refused.body.error as { code?: unknown } | undefined)?.code).toBe('CONFIG_INVALID')
          expect(await readSetting(running.base, index, setting)).toBe(admitted)
        }
      })
    }
  }
})
