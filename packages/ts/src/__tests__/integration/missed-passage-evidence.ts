import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Narsil } from '../../narsil'
import { type Passage, passagesNotFoundFirst } from './passages-by-file'

const MISSED_PASSAGE_EVIDENCE_DIR = resolve(process.cwd(), 'test-evidence', 'vector-misses')

async function saveMissedPassageEvidence(
  engine: Narsil,
  index: string,
  missed: string[],
  limit: number,
  efSearch: number,
): Promise<void> {
  const name = `${index}-limit-${limit}-ef-${efSearch}-${Date.now()}-${process.pid}`
  const snapshot = new Uint8Array(await new Response(await engine.snapshot(index)).arrayBuffer())
  await mkdir(MISSED_PASSAGE_EVIDENCE_DIR, { recursive: true })
  await writeFile(join(MISSED_PASSAGE_EVIDENCE_DIR, `${name}.nrsl`), snapshot)
  await writeFile(
    join(MISSED_PASSAGE_EVIDENCE_DIR, `${name}.json`),
    `${JSON.stringify(
      {
        index,
        limit,
        efSearch,
        missed,
        snapshot: `${name}.nrsl`,
        vectorMaintenance: engine.vectorMaintenanceStatus(index),
        node: process.version,
      },
      null,
      2,
    )}\n`,
  )
}

export async function passagesNotFoundFirstSavingEvidence(
  engine: Narsil,
  index: string,
  passages: Passage[],
  limit: number,
  efSearch: number,
): Promise<string[]> {
  const missed = await passagesNotFoundFirst(engine, index, passages, limit, efSearch)
  if (missed.length > 0) await saveMissedPassageEvidence(engine, index, missed, limit, efSearch)
  return missed
}
