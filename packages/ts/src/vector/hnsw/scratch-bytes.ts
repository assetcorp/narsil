import { nativeFieldFor, nativeServesWalk } from '../native/field'
import type { HNSWSearchState } from './shared'
import type { DistanceList, HNSWWorkspace } from './workspace'

function listBytes(list: DistanceList): number {
  return list.ords.byteLength + list.distances.byteLength
}

function workspaceBytes(workspace: HNSWWorkspace): number {
  let bytes =
    listBytes(workspace.frontier) +
    listBytes(workspace.found) +
    listBytes(workspace.traversal) +
    listBytes(workspace.working) +
    listBytes(workspace.pruneCandidates) +
    listBytes(workspace.pruneSelection) +
    listBytes(workspace.repairCandidates) +
    listBytes(workspace.repairSelection) +
    workspace.entryPoints.byteLength
  for (const list of workspace.linkSelections) bytes += listBytes(list)
  for (const list of workspace.placementCandidates) bytes += listBytes(list)
  return bytes
}

export function searchScratchBytes(state: HNSWSearchState): number {
  const held = workspaceBytes(state.workspace) + state.neighborScratch.byteLength
  const native = nativeFieldFor(state)
  if (native === null || !nativeServesWalk(native)) return held + state.visited.byteLength
  return (
    held +
    native.core.workspaceBytes() +
    native.ordinals.byteLength +
    native.distances.byteLength +
    native.layerCounts.byteLength
  )
}
