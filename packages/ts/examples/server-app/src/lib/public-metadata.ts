import { readBoundedText } from '@delali/narsil-example-shared/lib/bounded-read'
import * as v from 'valibot'
import { MAX_INDEX_REQUEST_BYTES } from './constants'
import { notesError } from './notes-identity'
import { isNotesIndex } from './notes-scope'

const RecordSchema = v.looseObject({ indexName: v.string() })
const TaskPageSchema = v.looseObject({ tasks: v.array(RecordSchema) })
const MemorySchema = v.looseObject({ workerCopies: v.array(RecordSchema), heldCheckpoints: v.array(RecordSchema) })

export async function publicMetadata(response: Response, path: string): Promise<Response> {
  const text = await readBoundedText(response, MAX_INDEX_REQUEST_BYTES)
  if (text === null) return notesError(502, 'SERVICE_UNAVAILABLE', 'The server metadata is too large')
  try {
    const body: unknown = JSON.parse(text)
    if (path === '/tasks') {
      const page = v.parse(TaskPageSchema, body)
      return Response.json(
        { ...page, tasks: page.tasks.filter(task => !isNotesIndex(task.indexName)) },
        {
          headers: { 'cache-control': 'no-store' },
        },
      )
    }
    const memory = v.parse(MemorySchema, body)
    return Response.json(
      {
        ...memory,
        workerCopies: memory.workerCopies.filter(record => !isNotesIndex(record.indexName)),
        heldCheckpoints: memory.heldCheckpoints.filter(record => !isNotesIndex(record.indexName)),
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch {
    return notesError(502, 'SERVICE_UNAVAILABLE', 'The server metadata is invalid')
  }
}

export async function publicTask(
  target: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<Response | null> {
  const headers = new Headers()
  if (apiKey !== undefined) headers.set('authorization', `Bearer ${apiKey}`)
  const response = await fetch(target, { headers, signal })
  if (!response.ok) return response
  const text = await readBoundedText(response, MAX_INDEX_REQUEST_BYTES)
  if (text === null) return notesError(502, 'SERVICE_UNAVAILABLE', 'The task record is too large')
  try {
    const task = v.parse(RecordSchema, JSON.parse(text))
    return isNotesIndex(task.indexName) ? notesError(403, 'FORBIDDEN', 'This task is private') : null
  } catch {
    return notesError(502, 'SERVICE_UNAVAILABLE', 'The task record is invalid')
  }
}
