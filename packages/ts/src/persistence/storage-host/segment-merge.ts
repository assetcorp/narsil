import type * as SegmentMergeCode from '../../core/segment-merge-leaf'

type SegmentMergeNames = Pick<
  typeof SegmentMergeCode,
  | 'buildSegmentPayloads'
  | 'createRequestId'
  | 'deserializePartition'
  | 'fieldIndexRemapOf'
  | 'freezeSegmentShared'
  | 'holdsADiscardedField'
  | 'mergeFieldIndexes'
  | 'mergePostings'
  | 'mergeSegmentContents'
  | 'mergeSourceSpellings'
  | 'mergeSourceSurfaces'
  | 'mergedPartialSpellings'
  | 'segmentArraysOf'
  | 'selectionKeeps'
  | 'shareSegmentArrays'
  | 'toError'
>

export let buildSegmentPayloads: SegmentMergeNames['buildSegmentPayloads']
export let createRequestId: SegmentMergeNames['createRequestId']
export let deserializePartition: SegmentMergeNames['deserializePartition']
export let fieldIndexRemapOf: SegmentMergeNames['fieldIndexRemapOf']
export let freezeSegmentShared: SegmentMergeNames['freezeSegmentShared']
export let holdsADiscardedField: SegmentMergeNames['holdsADiscardedField']
export let mergeFieldIndexes: SegmentMergeNames['mergeFieldIndexes']
export let mergePostings: SegmentMergeNames['mergePostings']
export let mergeSegmentContents: SegmentMergeNames['mergeSegmentContents']
export let mergeSourceSpellings: SegmentMergeNames['mergeSourceSpellings']
export let mergeSourceSurfaces: SegmentMergeNames['mergeSourceSurfaces']
export let mergedPartialSpellings: SegmentMergeNames['mergedPartialSpellings']
export let segmentArraysOf: SegmentMergeNames['segmentArraysOf']
export let selectionKeeps: SegmentMergeNames['selectionKeeps']
export let shareSegmentArrays: SegmentMergeNames['shareSegmentArrays']
export let toError: SegmentMergeNames['toError']

export function bindSegmentMergeNames(segmentMerge: SegmentMergeNames): void {
  ;({
    buildSegmentPayloads,
    createRequestId,
    deserializePartition,
    fieldIndexRemapOf,
    freezeSegmentShared,
    holdsADiscardedField,
    mergeFieldIndexes,
    mergePostings,
    mergeSegmentContents,
    mergeSourceSpellings,
    mergeSourceSurfaces,
    mergedPartialSpellings,
    segmentArraysOf,
    selectionKeeps,
    shareSegmentArrays,
    toError,
  } = segmentMerge)
}
