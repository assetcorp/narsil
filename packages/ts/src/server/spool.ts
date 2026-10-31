import type { FileHandle } from 'node:fs/promises'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SPOOL_PAUSE_ABOVE_BYTES } from './constants'
import { ServerErrorCodes } from './errors'
import type { ResponseAbort } from './request'
import { type ResponseSink, sendError } from './response'

export interface SpooledBody {
  path: string
  bytes: number
  remove(): Promise<void>
}

interface SpoolState {
  directory: string | null
  handle: FileHandle | null
  chain: Promise<void>
  queued: number
  total: number
  paused: boolean
  done: boolean
}

class NotAdmittedError extends Error {}

async function removeDirectory(directory: string | null): Promise<void> {
  if (directory !== null) await rm(directory, { recursive: true, force: true })
}

export function spoolBody(
  res: ResponseSink,
  maxBytes: number,
  abort: ResponseAbort,
  admitted: Promise<boolean>,
): Promise<SpooledBody> {
  return new Promise((resolve, reject) => {
    const state: SpoolState = {
      directory: null,
      handle: null,
      chain: Promise.resolve(),
      queued: 0,
      total: 0,
      paused: true,
      done: false,
    }

    const resumeReading = (): void => {
      if (!state.paused || abort.aborted) return
      state.paused = false
      res.resume()
    }

    const fail = (error: Error, answer: boolean): void => {
      if (state.done) return
      state.done = true
      resumeReading()
      if (answer && !abort.aborted) {
        sendError(res, 500, ServerErrorCodes.INTERNAL_ERROR, 'The server could not store the request body')
      }
      void state.chain
        .catch(() => undefined)
        .then(async () => {
          await state.handle?.close().catch(() => undefined)
          await removeDirectory(state.directory).catch(() => undefined)
        })
        .finally(() => reject(error))
    }
    const failFromChain = (error: unknown): void => {
      if (error instanceof NotAdmittedError) fail(error, false)
      else fail(error instanceof Error ? error : new Error(String(error)), true)
    }

    res.pause()
    state.chain = (async () => {
      if (!(await admitted)) throw new NotAdmittedError('the request was not admitted')
      state.directory = await mkdtemp(path.join(tmpdir(), 'narsil-spool-'))
      state.handle = await open(path.join(state.directory, 'body'), 'w')
      if (!state.done && state.queued <= SPOOL_PAUSE_ABOVE_BYTES) resumeReading()
    })()
    state.chain.catch(failFromChain)
    abort.onAbort(() => fail(new Error('aborted'), false))

    res.onData((chunk, isLast) => {
      if (state.done || abort.aborted) return
      state.total += chunk.byteLength
      if (maxBytes > 0 && state.total > maxBytes) {
        resumeReading()
        sendError(res, 413, ServerErrorCodes.PAYLOAD_TOO_LARGE, 'Request body exceeds the configured size limit')
        fail(new Error('payload too large'), false)
        return
      }
      const copy = new Uint8Array(chunk.slice(0))
      state.queued += copy.byteLength
      if (!state.paused && state.queued > SPOOL_PAUSE_ABOVE_BYTES) {
        state.paused = true
        res.pause()
      }
      state.chain = state.chain.then(async () => {
        if (state.handle === null) throw new Error('the spool file is not open')
        await state.handle.write(copy)
        state.queued -= copy.byteLength
        if (!state.done && state.queued <= SPOOL_PAUSE_ABOVE_BYTES) resumeReading()
      })
      state.chain.catch(failFromChain)
      if (!isLast) return
      state.chain.then(async () => {
        if (state.done) return
        state.done = true
        await state.handle?.close()
        resolve({
          path: path.join(state.directory ?? '', 'body'),
          bytes: state.total,
          remove: () => removeDirectory(state.directory),
        })
      }, failFromChain)
    })
  })
}
