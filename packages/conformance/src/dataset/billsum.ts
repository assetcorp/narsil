import { parquetReadObjects } from 'hyparquet'
import * as v from 'valibot'
import { sha256Of } from './artifact'
import { SOURCE_DATASET, SOURCE_REVISION } from './constants'
import { fetchBytes } from './http'

export interface SourceFile {
  split: string
  path: string
  sha256: string
  bytes: number
}

export interface BillRow {
  split: string
  row: number
  title: string
  summary: string
}

const BillColumns = v.object({ title: v.string(), summary: v.string() })

function sourceUrl(file: SourceFile): string {
  return `https://huggingface.co/datasets/${SOURCE_DATASET}/resolve/${SOURCE_REVISION}/${file.path}`
}

export async function firstRows(file: SourceFile, count: number): Promise<BillRow[]> {
  const bytes = await fetchBytes(sourceUrl(file), file.bytes)
  if (bytes.byteLength !== file.bytes || sha256Of(bytes) !== file.sha256) {
    throw new Error(`${file.path} at ${SOURCE_REVISION} differs from its recorded SHA-256`)
  }
  const rows = await parquetReadObjects({
    file: bytes.buffer,
    columns: ['title', 'summary'],
    rowStart: 0,
    rowEnd: count,
  })
  if (rows.length !== count) throw new Error(`${file.path} holds ${rows.length} rows, under ${count}`)
  return rows.map((raw, row) => {
    const result = v.safeParse(BillColumns, raw)
    if (!result.success) throw new Error(`row ${row} of ${file.path} has an unexpected shape`)
    return { split: file.split, row, ...result.output }
  })
}
