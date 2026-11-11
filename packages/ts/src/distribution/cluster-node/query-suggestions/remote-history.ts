import { encode } from '@msgpack/msgpack'
import { generateId } from '../../../core/id-generator'
import { compareCodePoints } from '../../../core/ordering'
import { HistoryStreamReader } from '../../../query-suggestions/counts-stream'
import type { HistoryFiles } from '../../../query-suggestions/history-files'
import { restoreStagingPrefix } from '../../../query-suggestions/history-files'
import type { RemoteFile } from '../../../query-suggestions/host'
import { QUERY_SUGGESTIONS_SPEC_VERSION, reachesVersion } from '../../cluster/version'
import type { NodeRegistration } from '../../coordinator/types'
import { SuggestionMessageTypes, type TransportMessage } from '../../transport/types'
import { resolveNodeTargets } from '../node-messaging'
import type { ClusterNodeConfig } from '../types'

export interface RemoteHistoryDeps {
  config: ClusterNodeConfig
  nodeId: string
  files: HistoryFiles
}

export interface StagedFile {
  key: string
  stagedKey: string
}

async function removeStaged(files: HistoryFiles, staged: readonly StagedFile[]): Promise<void> {
  for (const { stagedKey } of staged) await files.remove(stagedKey).catch(() => undefined)
}

async function streamFrom(
  deps: RemoteHistoryDeps,
  target: string,
  message: TransportMessage,
  indexName: string,
): Promise<StagedFile[] | null> {
  const prefix = restoreStagingPrefix()
  const reader = new HistoryStreamReader(indexName)
  const staged: StagedFile[] = []
  let writes: Promise<void> = Promise.resolve()
  let writeFailed = false
  try {
    await deps.config.transport.stream(target, message, chunk => {
      for (const file of reader.push(chunk)) {
        const entry = { key: file.key, stagedKey: `${prefix}${staged.length}` }
        staged.push(entry)
        writes = writes.then(() =>
          writeFailed
            ? undefined
            : deps.files.write(entry.stagedKey, file.bytes).catch(() => {
                writeFailed = true
              }),
        )
      }
    })
    await writes
  } catch {
    await writes
    await removeStaged(deps.files, staged)
    return null
  }
  if (writeFailed || reader.refusal !== null || !reader.endsCleanly) {
    await removeStaged(deps.files, staged)
    return null
  }
  return staged
}

export async function stageNodeHistory(
  deps: RemoteHistoryDeps,
  node: Pick<NodeRegistration, 'nodeId'>,
  indexName: string,
): Promise<StagedFile[] | null> {
  const message: TransportMessage = {
    type: SuggestionMessageTypes.COUNTS,
    sourceId: deps.nodeId,
    requestId: generateId(),
    payload: encode({ indexName }),
  }
  for (const target of await resolveNodeTargets(deps.config, node.nodeId)) {
    const staged = await streamFrom(deps, target, { ...message, requestId: generateId() }, indexName)
    if (staged !== null) return staged
  }
  return null
}

export async function peerNodesOf(deps: RemoteHistoryDeps): Promise<NodeRegistration[]> {
  return (await deps.config.coordinator.listNodes())
    .filter(node => node.nodeId !== deps.nodeId)
    .sort((left, right) => compareCodePoints(left.nodeId, right.nodeId))
}

export async function* remoteHistoryOf(deps: RemoteHistoryDeps, indexName: string): AsyncGenerator<RemoteFile> {
  for (const node of await peerNodesOf(deps)) {
    const staged = reachesVersion(node.version, QUERY_SUGGESTIONS_SPEC_VERSION)
      ? await stageNodeHistory(deps, node, indexName)
      : null
    if (staged === null) {
      yield { kind: 'silent', nodeId: node.nodeId }
      continue
    }
    try {
      for (const { key, stagedKey } of staged) {
        const bytes = await deps.files.read(stagedKey)
        if (bytes === null || bytes === 'too-long') continue
        yield { kind: 'file', nodeId: node.nodeId, key, bytes }
      }
    } finally {
      await removeStaged(deps.files, staged)
    }
  }
}
