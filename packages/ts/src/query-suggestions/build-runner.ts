import { ErrorCodes, NarsilError } from '#platform/suggestions-host'
import type { QuerySuggestionsBuild, QuerySuggestionsBuildTrigger } from '../types/query-suggestions'
import { runBuild } from './build'
import { type BuildRecord, publicBuildOf, SOURCES_DIGEST_BYTES } from './build-record'
import type { QuerySuggestionsRuntime } from './runtime'

export interface RunningBuild {
  build: QuerySuggestionsBuild
  started: Promise<void>
  done: Promise<QuerySuggestionsBuild>
}

function errorCodeOf(error: unknown): string {
  return error instanceof NarsilError ? error.code : ErrorCodes.WORKER_ACTION_FAILED
}

function runningRecordOf(identity: Pick<BuildRecord, 'buildId' | 'trigger' | 'startedAt'>): BuildRecord {
  return {
    ...identity,
    status: 'running',
    published: 0,
    removed: 0,
    discarded: 0,
    sourcesDigest: new Uint8Array(SOURCES_DIGEST_BYTES),
  }
}

function newBuild(
  trigger: QuerySuggestionsBuildTrigger,
  status: QuerySuggestionsBuild['status'],
): QuerySuggestionsBuild {
  return {
    buildId: globalThis.crypto.randomUUID(),
    trigger,
    status,
    startedAt: Date.now(),
    endedAt: null,
    published: 0,
    removed: 0,
    discarded: 0,
    errorCode: null,
  }
}

export class BuildRunner {
  private readonly runtime: QuerySuggestionsRuntime
  private readonly running = new Map<string, RunningBuild>()
  private readonly finished = new Map<string, QuerySuggestionsBuild>()

  constructor(runtime: QuerySuggestionsRuntime) {
    this.runtime = runtime
  }

  async lastBuild(indexName: string): Promise<QuerySuggestionsBuild | null> {
    const running = this.running.get(indexName)
    if (running !== undefined) return { ...running.build }
    const finished = this.finished.get(indexName)
    if (finished !== undefined) return { ...finished }
    const record = await this.runtime.host.readBuildRecord(indexName).catch(() => null)
    return record === null ? null : publicBuildOf(record)
  }

  isRunning(indexName: string): boolean {
    return this.running.has(indexName)
  }

  start(indexName: string, trigger: QuerySuggestionsBuildTrigger): Promise<QuerySuggestionsBuild> {
    return this.begin(indexName, trigger).done
  }

  begin(indexName: string, trigger: QuerySuggestionsBuildTrigger): RunningBuild {
    this.runtime.enabledSetting(indexName)
    if (this.runtime.scrambler === null) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        'This engine has no query suggestions key, so it builds no suggestions',
        { indexName },
      )
    }
    if (this.runtime.isStopping) throw new NarsilError(ErrorCodes.INSTANCE_SHUT_DOWN, 'The engine is shutting down')
    if (this.running.has(indexName)) {
      const skipped = { ...newBuild(trigger, 'skipped'), endedAt: Date.now() }
      this.emitPhase(indexName, skipped)
      return { build: skipped, started: Promise.resolve(), done: Promise.resolve(skipped) }
    }
    const build = newBuild(trigger, 'running')
    let markStarted = (): void => undefined
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const done = this.run(indexName, build, markStarted)
    void done.finally(markStarted)
    const running = { build, started, done }
    this.running.set(indexName, running)
    void done.finally(() => {
      if (this.running.get(indexName)?.build === build) this.running.delete(indexName)
    })
    return running
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map(running => running.done))
  }

  forget(indexName: string): void {
    this.finished.delete(indexName)
  }

  private emitPhase(indexName: string, build: QuerySuggestionsBuild): void {
    const phase = build.status === 'running' ? 'started' : build.status
    this.runtime.host.emit('querySuggestionsBuild', {
      indexName,
      buildId: build.buildId,
      phase,
      trigger: build.trigger,
      published: build.published,
      removed: build.removed,
      discarded: build.discarded,
      ...(build.errorCode !== null ? { errorCode: build.errorCode } : {}),
    })
  }

  private async lastCompleted(indexName: string): Promise<BuildRecord | null> {
    const record = await this.runtime.host.readBuildRecord(indexName).catch(() => null)
    return record !== null && (record.status === 'completed' || record.status === 'skipped') ? record : null
  }

  private async run(
    indexName: string,
    build: QuerySuggestionsBuild,
    markStarted: () => void,
  ): Promise<QuerySuggestionsBuild> {
    await Promise.resolve()
    this.emitPhase(indexName, build)
    const runtime = this.runtime
    let record: BuildRecord
    const identity = { buildId: build.buildId, trigger: build.trigger, startedAt: build.startedAt }
    try {
      const scrambler = runtime.scrambler
      if (scrambler === null)
        throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'This engine has no query suggestions key')
      const lastCompleted = await this.lastCompleted(indexName)
      if (runtime.host.clustered) await runtime.host.writeBuildRecord(indexName, runningRecordOf(identity))
      markStarted()
      const outcome = await runBuild(
        {
          host: runtime.host,
          scrambler,
          saveDay: name => runtime.saveDay(name),
          withWriteLock: (name, work) => runtime.withWriteLock(name, work),
          isStopping: () => runtime.isStopping,
        },
        indexName,
        lastCompleted,
        build.startedAt,
      )
      record = { ...identity, ...outcome, endedAt: Date.now() }
    } catch (error) {
      record = {
        ...identity,
        status: 'failed',
        endedAt: Date.now(),
        published: 0,
        removed: 0,
        discarded: 0,
        sourcesDigest: new Uint8Array(SOURCES_DIGEST_BYTES),
        errorCode: errorCodeOf(error),
      }
    }
    const finalRecord = record
    await runtime.host.writeBuildRecord(indexName, finalRecord).catch((error: unknown) => {
      runtime.host.emit('querySuggestionsWarning', {
        indexName,
        reason: 'save-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    })
    const finished = publicBuildOf(finalRecord)
    this.finished.set(indexName, finished)
    this.emitPhase(indexName, finished)
    return finished
  }
}
