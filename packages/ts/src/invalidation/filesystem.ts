import type { InvalidationAdapter, InvalidationEvent } from '../types/adapters'

export interface FilesystemInvalidationConfig {
  directory: string
  pollInterval?: number
  instanceId?: string
}

const MARKER_MAX_AGE_MS = 60_000
const DEFAULT_POLL_INTERVAL = 1000

function generateInstanceId(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `inst-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function isValidDirectory(directory: string): boolean {
  const normalized = directory.replace(/\\/g, '/')
  if (normalized.includes('..')) {
    return false
  }
  return true
}

function isInvalidationEvent(data: unknown): data is InvalidationEvent {
  if (typeof data !== 'object' || data === null) {
    return false
  }
  const record = data as Record<string, unknown>
  return record.type === 'partition' || record.type === 'statistics'
}

export function createFilesystemInvalidation(config: FilesystemInvalidationConfig): InvalidationAdapter {
  if (!isValidDirectory(config.directory)) {
    throw new Error(`Invalid directory path: path traversal detected in "${config.directory}"`)
  }

  const directory = config.directory
  const pollInterval = config.pollInterval ?? DEFAULT_POLL_INTERVAL
  const instanceId = config.instanceId ?? generateInstanceId()

  let lastProcessedTimestamp = Date.now()
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let handler: ((event: InvalidationEvent) => void) | null = null

  async function ensureDirectory(): Promise<void> {
    const fs = await import('node:fs/promises')
    try {
      await fs.mkdir(directory, { recursive: true })
    } catch {
      /* directory may already exist */
    }
  }

  async function processMarkerFiles(): Promise<void> {
    if (!handler) {
      return
    }

    const fs = await import('node:fs/promises')
    const path = await import('node:path')

    let files: string[]
    try {
      files = await fs.readdir(directory)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw err
    }

    const jsonFiles = files.filter(f => f.endsWith('.json')).sort()
    const now = Date.now()

    for (const file of jsonFiles) {
      const filePath = path.join(directory, file)

      let content: string
      try {
        content = await fs.readFile(filePath, 'utf-8')
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue
        }
        throw err
      }

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(content) as Record<string, unknown>
      } catch {
        try {
          await fs.unlink(filePath)
        } catch {
          /* file may have been deleted by another instance */
        }
        continue
      }

      const writtenAt = typeof parsed.writtenAt === 'number' ? parsed.writtenAt : 0

      if (writtenAt <= lastProcessedTimestamp) {
        if (now - writtenAt > MARKER_MAX_AGE_MS) {
          try {
            await fs.unlink(filePath)
          } catch {
            /* file may have been deleted by another instance */
          }
        }
        continue
      }

      if (parsed.instanceId === instanceId) {
        if (now - writtenAt > MARKER_MAX_AGE_MS) {
          try {
            await fs.unlink(filePath)
          } catch {
            /* already removed */
          }
        }
        continue
      }

      if (isInvalidationEvent(parsed)) {
        handler(parsed)
      }

      if (writtenAt > lastProcessedTimestamp) {
        lastProcessedTimestamp = writtenAt
      }

      if (now - writtenAt > MARKER_MAX_AGE_MS) {
        try {
          await fs.unlink(filePath)
        } catch {
          /* already removed */
        }
      }
    }
  }

  return {
    async publish(event: InvalidationEvent): Promise<void> {
      await ensureDirectory()

      const fs = await import('node:fs/promises')
      const path = await import('node:path')

      const timestamp = Date.now()
      const filename = `${timestamp}-${instanceId}.json`
      const filePath = path.join(directory, filename)
      const payload = JSON.stringify({ ...event, instanceId, writtenAt: timestamp })

      await fs.writeFile(filePath, payload, 'utf-8')
    },

    async subscribe(fn: (event: InvalidationEvent) => void): Promise<void> {
      handler = fn
      lastProcessedTimestamp = Date.now()

      pollTimer = setInterval(() => {
        processMarkerFiles().catch(() => {
          /* swallow poll errors to keep the interval alive */
        })
      }, pollInterval)
    },

    async shutdown(): Promise<void> {
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      handler = null

      const fs = await import('node:fs/promises')
      const path = await import('node:path')

      let files: string[]
      try {
        files = await fs.readdir(directory)
      } catch {
        return
      }

      const ownFiles = files.filter(f => f.endsWith(`-${instanceId}.json`))
      for (const file of ownFiles) {
        try {
          await fs.unlink(path.join(directory, file))
        } catch {
          /* already removed */
        }
      }
    },
  }
}
