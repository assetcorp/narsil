import { BLOCK_SUMMARY_BYTES, type FileSection, loadFailed, sectionNamed } from './format'

export function requirePagedColumnLengths(
  sections: readonly FileSection[],
  documents: number,
  tokens: number,
  postings: number,
  key: string,
): void {
  const required = (name: string): FileSection => {
    const section = sectionNamed(sections, name)
    if (section === undefined) loadFailed(`The segment "${key}" holds no section "${name}"`)
    return section
  }
  const exact = (name: string, length: number): void => {
    if (required(name).length !== length) loadFailed(`Section "${name}" of "${key}" has the wrong length`)
  }
  exact('idOffsets', (documents + 1) * 4)
  exact('idOrder', documents * 4)
  exact('removalOffsets', (documents + 1) * 4)
  exact('tokenTotals', tokens * 8)
  if (required('removals').length % 8 !== 0) loadFailed(`The removal pairs of "${key}" are cut short`)
  if (documents === 0) {
    exact('ids', 0)
    exact('removals', 0)
  }
  const positions = sectionNamed(sections, 'positions')
  if (positions !== undefined) {
    exact('positionOffsets', (postings + 1) * 4)
    if (positions.length % 4 !== 0) loadFailed(`The positions of "${key}" are cut short`)
    if (postings === 0) exact('positions', 0)
  }
  const sequences = sectionNamed(sections, 'seqNos')
  const terms = sectionNamed(sections, 'primaryTerms')
  if ((sequences === undefined) !== (terms === undefined)) loadFailed(`The write records of "${key}" are incomplete`)
  if (sequences !== undefined) {
    exact('seqNos', documents * 8)
    exact('primaryTerms', documents * 8)
  }
}

export function requireBlockSummaryList(
  summaries: Uint8Array,
  first: number,
  end: number,
  postings: number,
  key: string,
): void {
  const view = new DataView(summaries.buffer, summaries.byteOffset, summaries.byteLength)
  let previous = 0
  for (let block = first; block < end; block++) {
    const at = block * BLOCK_SUMMARY_BYTES
    const next = view.getUint32(at, true)
    const minimum = view.getFloat64(at + 6, true)
    const entries = view.getUint32(at + 14, true)
    const documents = view.getUint32(at + 18, true)
    if (
      next <= previous ||
      next > postings ||
      !Number.isFinite(minimum) ||
      minimum < 0 ||
      entries === 0 ||
      entries > next - previous ||
      documents === 0 ||
      documents > next - previous
    )
      loadFailed(`Block ${block} of "${key}" holds invalid bounds`, { block })
    previous = next
  }
  if (first === end || previous !== postings) loadFailed(`The block summaries of "${key}" do not cover their list`)
}
