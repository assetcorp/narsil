import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withinDeadline } from './deadline'
import type { Json } from './forms/json'
import { formDifference } from './forms/kinds'
import { referenceForm } from './reference/read'
import { readCatalog, readExpected, type SampleEntry } from './samples/catalog'

export interface CheckOutcome {
  name: string
  problem: string | null
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return 'code' in error && typeof error.code === 'string' ? `${error.code}: ${error.message}` : error.message
}

async function outcomeOf(entry: SampleEntry, check: () => Promise<Json>): Promise<CheckOutcome> {
  try {
    const actual = await withinDeadline(check(), `the sample ${entry.name}`)
    return { name: entry.name, problem: formDifference(entry.kind, await readExpected(entry), actual) }
  } catch (error) {
    return { name: entry.name, problem: messageOf(error) }
  }
}

export function readOutputPath(directory: string, entry: SampleEntry): string {
  return join(directory, `${entry.name}.json`)
}

export function writtenFilePath(directory: string, entry: SampleEntry): string {
  return join(directory, entry.name)
}

export async function checkRead(directory: string): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = []
  for (const entry of await readCatalog()) {
    outcomes.push(
      await outcomeOf(entry, async () => JSON.parse(await readFile(readOutputPath(directory, entry), 'utf8'))),
    )
  }
  return outcomes
}

export async function checkWritten(directory: string): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = []
  for (const entry of await readCatalog()) {
    outcomes.push(
      await outcomeOf(entry, async () => {
        const bytes = new Uint8Array(await readFile(writtenFilePath(directory, entry)))
        return referenceForm({ kind: entry.kind, bytes, what: entry.name, storage: entry.storage })
      }),
    )
  }
  return outcomes
}
