import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError, ServerErrorCodes } from '../../errors'
import { pause } from '../cluster/rebalance/pause'
import type { ClusterCoordinator } from '../coordinator/types'
import { isRecord } from '../payload-guards'
import {
  BACKUP_JOB_CAS_ATTEMPTS,
  BACKUP_JOB_CAS_RETRY_MS,
  BACKUP_JOBS_KEY,
  MAX_FINISHED_BACKUP_JOBS,
} from './constants'
import { isCount } from './manifest'

export type BackupJobKind = 'backup' | 'restore' | 'delete'
export type BackupJobStatus = 'running' | 'done' | 'failed'

export interface BackupJobError {
  code: string
  message: string
}

export interface BackupJob {
  kind: BackupJobKind
  backupName: string
  indexName?: string
  generation?: string
  nameIndexUuid?: string
  status: BackupJobStatus
  partitionsDone: number
  partitionsTotal: number
  startedAt: number
  finishedAt?: number
  error?: BackupJobError
}

const KINDS: ReadonlySet<string> = new Set<BackupJobKind>(['backup', 'restore', 'delete'])
const STATUSES: ReadonlySet<string> = new Set<BackupJobStatus>(['running', 'done', 'failed'])
const ABSENT = new Uint8Array(0)

function malformed(): never {
  throw new NarsilError(
    ErrorCodes.CONTROLLER_METADATA_INVALID,
    `The value stored under '${BACKUP_JOBS_KEY}' is malformed`,
    { key: BACKUP_JOBS_KEY },
  )
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function decodeJobError(value: unknown): BackupJobError | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') malformed()
  return { code: value.code, message: value.message }
}

function decodeJob(value: unknown): BackupJob {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    !KINDS.has(value.kind) ||
    typeof value.backupName !== 'string' ||
    !isOptionalString(value.indexName) ||
    !isOptionalString(value.generation) ||
    !isOptionalString(value.nameIndexUuid) ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status) ||
    !isCount(value.partitionsDone) ||
    !isCount(value.partitionsTotal) ||
    !isCount(value.startedAt) ||
    !(value.finishedAt === undefined || isCount(value.finishedAt))
  ) {
    malformed()
  }
  const error = decodeJobError(value.error)
  return {
    kind: value.kind as BackupJobKind,
    backupName: value.backupName,
    ...(value.indexName === undefined ? {} : { indexName: value.indexName }),
    ...(value.generation === undefined ? {} : { generation: value.generation }),
    ...(value.nameIndexUuid === undefined ? {} : { nameIndexUuid: value.nameIndexUuid }),
    status: value.status as BackupJobStatus,
    partitionsDone: value.partitionsDone,
    partitionsTotal: value.partitionsTotal,
    startedAt: value.startedAt,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    ...(error === undefined ? {} : { error }),
  }
}

interface StoredJobs {
  jobs: Map<string, BackupJob>
  bytes: Uint8Array | null
}

async function readStoredJobs(coordinator: ClusterCoordinator): Promise<StoredJobs> {
  const bytes = await coordinator.get(BACKUP_JOBS_KEY)
  const jobs = new Map<string, BackupJob>()
  if (bytes === null || bytes.byteLength === 0) return { jobs, bytes }
  let raw: unknown
  try {
    raw = decode(bytes)
  } catch (_) {
    malformed()
  }
  if (!isRecord(raw)) malformed()
  for (const [jobId, value] of Object.entries(raw)) jobs.set(jobId, decodeJob(value))
  return { jobs, bytes }
}

function encodeJobs(jobs: Map<string, BackupJob>): Uint8Array {
  if (jobs.size === 0) return ABSENT
  return new Uint8Array(encode(Object.fromEntries(jobs), { ignoreUndefined: true }))
}

function keepNewestFinished(jobs: Map<string, BackupJob>): void {
  const finished = [...jobs].filter(([, job]) => job.status !== 'running')
  if (finished.length <= MAX_FINISHED_BACKUP_JOBS) return
  finished.sort(([, left], [, right]) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0))
  for (const [jobId] of finished.slice(0, finished.length - MAX_FINISHED_BACKUP_JOBS)) jobs.delete(jobId)
}

export type JobsChange = (jobs: Map<string, BackupJob>) => boolean

export async function changeBackupJobs(coordinator: ClusterCoordinator, change: JobsChange): Promise<boolean> {
  for (let attempt = 0; attempt < BACKUP_JOB_CAS_ATTEMPTS; attempt++) {
    const stored = await readStoredJobs(coordinator)
    if (!change(stored.jobs)) return false
    keepNewestFinished(stored.jobs)
    if (await coordinator.compareAndSet(BACKUP_JOBS_KEY, stored.bytes, encodeJobs(stored.jobs))) return true
    await pause(BACKUP_JOB_CAS_RETRY_MS)
  }
  throw new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `The backup job record lost ${BACKUP_JOB_CAS_ATTEMPTS} compare-and-set attempts`,
    { key: BACKUP_JOBS_KEY },
  )
}

export async function readBackupJobs(coordinator: ClusterCoordinator): Promise<Map<string, BackupJob>> {
  return (await readStoredJobs(coordinator)).jobs
}

function conflictOf(jobs: Map<string, BackupJob>, job: BackupJob): BackupJob | undefined {
  for (const running of jobs.values()) {
    if (running.status !== 'running') continue
    const sameBackup = running.backupName === job.backupName
    if (job.kind === 'backup' && (running.kind === 'delete' || (running.kind === 'backup' && sameBackup))) {
      return running
    }
    if (job.kind === 'restore' && running.kind === 'delete' && sameBackup) return running
    if (job.kind === 'delete' && (running.kind !== 'restore' || sameBackup)) return running
  }
  return undefined
}

function refusal(job: BackupJob, conflicting: BackupJob): NarsilError {
  if (job.kind === 'backup' && conflicting.kind === 'backup') {
    return new NarsilError(ErrorCodes.BACKUP_ALREADY_EXISTS, `A backup named '${job.backupName}' is already running`, {
      backupName: job.backupName,
    })
  }
  return new NarsilError(
    ErrorCodes.BACKUP_IN_PROGRESS,
    `A ${conflicting.kind} of backup '${conflicting.backupName}' is running, so the ${job.kind} of '${job.backupName}' can start once it ends`,
    { backupName: job.backupName, running: conflicting.kind, runningBackup: conflicting.backupName },
  )
}

export async function startBackupJob(coordinator: ClusterCoordinator, jobId: string, job: BackupJob): Promise<void> {
  let conflicting: BackupJob | undefined
  await changeBackupJobs(coordinator, jobs => {
    conflicting = conflictOf(jobs, job)
    if (conflicting !== undefined) return false
    jobs.set(jobId, job)
    return true
  })
  if (conflicting !== undefined) throw refusal(job, conflicting)
}

export async function updateBackupJob(
  coordinator: ClusterCoordinator,
  jobId: string,
  change: (job: BackupJob) => BackupJob,
): Promise<boolean> {
  return changeBackupJobs(coordinator, jobs => {
    const current = jobs.get(jobId)
    if (current === undefined || current.status !== 'running') return false
    jobs.set(jobId, change(current))
    return true
  })
}

export function backupFailureOf(error: unknown): BackupJobError {
  if (error instanceof NarsilError) return { code: error.code, message: error.message }
  return { code: ServerErrorCodes.INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) }
}

export function finishedJob(job: BackupJob, error: unknown): BackupJob {
  if (error === null) return { ...job, status: 'done', finishedAt: Date.now() }
  return { ...job, status: 'failed', finishedAt: Date.now(), error: backupFailureOf(error) }
}

export async function finishBackupJob(coordinator: ClusterCoordinator, jobId: string, error: unknown): Promise<void> {
  await updateBackupJob(coordinator, jobId, job => finishedJob(job, error))
}
