import { type CaseBuild, type CheckpointBuild, damagedCheckpoint } from './build'
import { baseFile, packedUint32s, uint32s } from './bytes'
import {
  type PagedLayout,
  type PagedPacking,
  packedPaged,
  pagedLayoutOf,
  sectionBytes,
  sectionNamed,
  sectionsOf,
  withSectionBytes,
} from './paged'

const INDEX = 'notes'
const SEGMENT = 'segments/0/s0000000000000000'
const LOAD_FAILED = 'PERSISTENCE_LOAD_FAILED'
const CRC_MISMATCH = 'PERSISTENCE_CRC_MISMATCH'
const PAYLOAD_RULE = 'envelope.md#paged-keyword-segment-payload'
const CHECKS_RULE = 'envelope.md#checks-on-a-paged-segment'
const SHORT_PAGE_BYTES = 16_384
const POSTING_BYTES = 8
const ORDINAL_BYTES = 4
const DOCUMENT_BLOCK_RAW_LENGTH_OFFSET = 16
const MAX_RAW_LENGTH = 16_842_752
const SEARCHED_TOKEN = 'kettl'
const SEARCHED_WORD = 'kettle'
const REMOVED_SECOND_DOCUMENT = 'note-001'
const REMOVED_FIRST_DOCUMENT = 'note-000'

interface PagedChange {
  name: string
  rule: string
  code: string
  change: (layout: PagedLayout) => PagedPacking | undefined
  search?: string
  remove?: string
}

function tokenIndex(layout: PagedLayout, token: string): number {
  const offsets = uint32s(sectionBytes(layout, 'tokenOffsets'))
  const text = sectionBytes(layout, 'tokens')
  const decoder = new TextDecoder()
  for (let at = 0; at + 1 < offsets.length; at++) {
    if (decoder.decode(text.subarray(offsets[at], offsets[at + 1])) === token) return at
  }
  throw new Error(`the paged segment holds no token ${token}`)
}

function changedWords(layout: PagedLayout, name: string, change: (values: number[]) => void): void {
  const values = uint32s(sectionBytes(layout, name))
  change(values)
  withSectionBytes(layout, name, packedUint32s(values))
}

function swappedPostings(layout: PagedLayout): void {
  const token = tokenIndex(layout, SEARCHED_TOKEN)
  const offsets = uint32s(sectionBytes(layout, 'postingOffsets'))
  const first = offsets[token] ?? 0
  const count = (offsets[token + 1] ?? 0) - first
  if (count < 2) throw new Error(`${SEARCHED_TOKEN} holds fewer than two postings`)
  const postings = sectionBytes(layout, 'postings')
  const view = new DataView(postings.buffer, postings.byteOffset, postings.byteLength)
  const start = first * POSTING_BYTES
  const ordinal = view.getUint32(start, true)
  view.setUint32(start, view.getUint32(start + ORDINAL_BYTES, true), true)
  view.setUint32(start + ORDINAL_BYTES, ordinal, true)
  withSectionBytes(layout, 'postings', postings)
}

function firstShortSection(layout: PagedLayout): string {
  const section = sectionsOf(layout).find(candidate => Number(candidate.length) <= SHORT_PAGE_BYTES)
  if (section === undefined || typeof section.name !== 'string') throw new Error('every section passes one page')
  return section.name
}

function lastSection(layout: PagedLayout) {
  const sections = sectionsOf(layout)
  return sections.reduce((last, section) => (Number(section.offset) > Number(last.offset) ? section : last))
}

const PAGED_CHANGES: PagedChange[] = [
  {
    name: 'paged-compressed',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    change: () => ({ header: { envelopeFormatVersion: 6, compression: 'gzip', checksum: true } }),
  },
  {
    name: 'paged-head-version',
    rule: PAYLOAD_RULE,
    code: 'ENVELOPE_VERSION_MISMATCH',
    change: layout => {
      layout.head.v = 2
      return undefined
    },
  },
  {
    name: 'paged-head-length-outside-payload',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    change: layout => ({ headLength: layout.payload.byteLength }),
  },
  {
    name: 'paged-head-checksum',
    rule: CHECKS_RULE,
    code: CRC_MISMATCH,
    change: () => ({ headChecksum: 0 }),
  },
  {
    name: 'paged-page-bytes',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    change: layout => {
      sectionNamed(layout, firstShortSection(layout)).pageBytes = SHORT_PAGE_BYTES
      return undefined
    },
  },
  {
    name: 'paged-section-repeated',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    change: layout => {
      const sections = sectionsOf(layout)
      const [first, second] = sections
      if (first === undefined || second === undefined) throw new Error('the paged segment holds one section')
      second.name = first.name
      layout.head.sections = sections
      return undefined
    },
  },
  {
    name: 'paged-sections-overlap',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    change: layout => {
      const sections = [...sectionsOf(layout)].sort((left, right) => Number(left.offset) - Number(right.offset))
      const [first, second] = sections
      if (first === undefined || second === undefined) throw new Error('the paged segment holds one section')
      second.offset = Number(second.offset) - 4
      return undefined
    },
  },
  {
    name: 'paged-section-outside-payload',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    change: layout => {
      const last = lastSection(layout)
      last.length = Number(last.length) + 4
      return undefined
    },
  },
  {
    name: 'paged-checksums-length',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    change: layout => {
      const section = sectionNamed(layout, 'tokens')
      const checksums = section.checksums
      if (!(checksums instanceof Uint8Array)) throw new Error('tokens holds no checksums')
      section.checksums = new Uint8Array([...checksums, 0, 0, 0, 0])
      return undefined
    },
  },
  {
    name: 'paged-page-checksum',
    rule: CHECKS_RULE,
    code: CRC_MISMATCH,
    change: layout => {
      const offset = Number(sectionNamed(layout, 'tokens').offset)
      layout.payload[offset] = (layout.payload[offset] ?? 0) ^ 0x01
      return undefined
    },
  },
  {
    name: 'paged-postings-descend',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    search: SEARCHED_WORD,
    change: layout => {
      swappedPostings(layout)
      return undefined
    },
  },
  {
    name: 'paged-block-lists-descend',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    change: layout => {
      changedWords(layout, 'blockLists', values => {
        const [first, second] = values
        if (first === undefined || second === undefined) throw new Error('blockLists holds one list')
        values[0] = second
        values[1] = first
      })
      return undefined
    },
  },
  {
    name: 'paged-block-list-past-tokens',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    change: layout => {
      const tokenCount = uint32s(sectionBytes(layout, 'tokenOffsets')).length - 1
      changedWords(layout, 'blockLists', values => {
        values[values.length - 1] = tokenCount
      })
      return undefined
    },
  },
  {
    name: 'paged-block-list-of-a-short-list',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    change: layout => {
      changedWords(layout, 'blockLists', values => {
        values[0] = 0
      })
      return undefined
    },
  },
  {
    name: 'paged-document-block-too-long',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    change: layout => {
      const blocks = sectionBytes(layout, 'documentBlocks')
      new DataView(blocks.buffer, blocks.byteOffset).setUint32(
        DOCUMENT_BLOCK_RAW_LENGTH_OFFSET,
        MAX_RAW_LENGTH + 1,
        true,
      )
      withSectionBytes(layout, 'documentBlocks', blocks)
      return undefined
    },
  },
  {
    name: 'paged-removal-offset-odd',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    remove: REMOVED_FIRST_DOCUMENT,
    change: layout => {
      changedWords(layout, 'removalOffsets', values => {
        values[1] = (values[1] ?? 0) + 1
      })
      return undefined
    },
  },
  {
    name: 'paged-removal-offsets-decrease',
    rule: PAYLOAD_RULE,
    code: LOAD_FAILED,
    remove: REMOVED_SECOND_DOCUMENT,
    change: layout => {
      changedWords(layout, 'removalOffsets', values => {
        values[1] = (values[2] ?? 0) + 2
      })
      return undefined
    },
  },
]

export async function pagedSegmentCases(): Promise<CaseBuild[]> {
  const segment = await baseFile(INDEX, SEGMENT)
  const builds: CaseBuild[] = []
  for (const { name, rule, code, change, search, remove } of PAGED_CHANGES) {
    const layout = pagedLayoutOf(segment)
    const packing = change(layout)
    const build: CheckpointBuild = damagedCheckpoint(name, rule, code, INDEX, {
      [SEGMENT]: await packedPaged(layout, packing),
    })
    builds.push({ ...build, ...(search === undefined ? {} : { search }), ...(remove === undefined ? {} : { remove }) })
  }
  return builds
}
