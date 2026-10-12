import { existsSync } from 'node:fs'
import { expect } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import type { NarsilConfig } from '../../../types/config'
import type { FilterExpression } from '../../../types/filters'
import type { AnyDocument } from '../../../types/schema'
import { postJson, scaledOut, startTestServer, type TestServer, waitFor } from '../../server/helpers'
import { type Churn, COMMON_TERM, INDEX, SCHEMA } from './corpus'
import { fieldVerdict, type Verdict } from './oracle'

export const WORKERS_BUILT = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))
const RESULT_LIMIT = 10_000

export interface FilterServer {
  readonly label: string
  readonly server: TestServer
  readonly client: NarsilClient
}

export async function startFilterServer(
  label: string,
  config: NarsilConfig,
  documents: AnyDocument[],
  maxPartitions: number,
): Promise<FilterServer> {
  const server = await startTestServer(undefined, config)
  const client = createNarsilClient({ url: server.base })
  await client.createIndex(INDEX, { schema: SCHEMA, partitions: { maxPartitions } })
  const inserted = await client.insertBatch(INDEX, documents)
  expect(inserted.failed).toEqual([])
  if (config.workers?.enabled !== false) await waitFor(() => scaledOut(server.engine, INDEX))
  return { label, server, client }
}

export async function applyChurn(target: FilterServer, churn: Churn): Promise<void> {
  const updated = await target.client.updateBatch(INDEX, churn.updates, { wait: true })
  expect(updated.failed).toEqual([])
  const removed = await target.client.removeBatch(INDEX, churn.removals, { wait: true })
  expect(removed.failed).toEqual([])
}

export interface FilterAnswer {
  searched: string[]
  listed: string[]
  counted: number
}

export async function answerOf(target: FilterServer, filters: FilterExpression): Promise<FilterAnswer> {
  const searched = await target.client.query(INDEX, { term: COMMON_TERM, filters, limit: RESULT_LIMIT })
  const listed = await postJson<{ documents: Array<{ id: string }> }>(
    target.server.base,
    `/indexes/${INDEX}/documents/_list`,
    { filters, limit: RESULT_LIMIT },
  )
  expect(listed.status, JSON.stringify(filters)).toBe(200)
  const counted = await target.client.preflight(INDEX, { term: COMMON_TERM, filters })
  return {
    searched: searched.hits.map(hit => hit.id).sort(),
    listed: listed.body.documents.map(document => document.id).sort(),
    counted: counted.count,
  }
}

export function expressionVerdict(document: AnyDocument, expression: FilterExpression): Verdict {
  const verdicts: Verdict[] = []
  for (const [field, filter] of Object.entries(expression.fields ?? {})) {
    verdicts.push(fieldVerdict(document, field, filter as Record<string, unknown>))
  }
  if (expression.and !== undefined)
    verdicts.push(allOf(expression.and.map(child => expressionVerdict(document, child))))
  if (expression.or !== undefined) verdicts.push(anyOf(expression.or.map(child => expressionVerdict(document, child))))
  if (expression.not !== undefined) {
    const inner = expressionVerdict(document, expression.not)
    verdicts.push(inner === null ? null : !inner)
  }
  return allOf(verdicts)
}

function allOf(verdicts: Verdict[]): Verdict {
  if (verdicts.includes(false)) return false
  return verdicts.includes(null) ? null : true
}

function anyOf(verdicts: Verdict[]): Verdict {
  if (verdicts.includes(true)) return true
  return verdicts.includes(null) ? null : false
}

export function expectAgreesWithOracle(
  documents: readonly AnyDocument[],
  filters: FilterExpression,
  matched: readonly string[],
): number {
  const found = new Set(matched)
  let decided = 0
  for (const document of documents) {
    const verdict = expressionVerdict(document, filters)
    if (verdict === null) continue
    decided++
    expect(
      found.has(String(document.id)),
      `${document.id} ${JSON.stringify(filters)} ${JSON.stringify(document)}`,
    ).toBe(verdict)
  }
  return decided
}
