/** An open read-only file that the core retains until its last operation finishes. @internal */
export interface NativePagedFileHandle {
  /** The stable identity that distinguishes this open file from every other handle. */
  readonly identity: bigint
  /** The file length in bytes when the core opened it. */
  readonly length: bigint
}

/** The page storage and lookup regions that one searching thread owns. @internal */
export interface NativePageCache {
  /** The page slots, each occupying 65,536 bytes. */
  bytes: Uint8Array
  /** The stable file identity of each slot, or zero for an unused slot. */
  files: BigUint64Array
  /** The absolute section offset of each slot. */
  offsets: BigUint64Array
  /** The page number within the section of each slot. */
  pages: BigUint64Array
  /** The number of valid bytes in each slot. */
  lengths: Uint32Array
  /** The expected CRC32 of each slot. */
  checksums: Uint32Array
}

/** The location and page checksums of one section in an open file. @internal */
export interface NativePageSection {
  /** The file that holds the section. */
  file: NativePagedFileHandle
  /** The absolute byte offset from the start of the file. */
  offset: bigint
  /** The section length in bytes. */
  length: bigint
  /** The page length, either 16,384 or 65,536 bytes. */
  pageBytes: number
  /** One little-endian uint32 CRC32 for each page. */
  checksums: Uint8Array
}

/** The vector rows and deletion bits of one file within a field. @internal */
export interface NativePagedVectorFile {
  /** The first global vector number in the file. */
  first: number
  /** The number of vectors in the file. */
  count: number
  /** The manifest's local deletion bits in bytes, or null when every vector is live. */
  dead: Uint8Array | null
  /** The full-precision float32 vector rows. */
  vectors: NativePageSection
  /** The packed OSQ records, or null for an unquantised field. */
  records: NativePageSection | null
}

/** The resident node metadata and paged neighbour lists of one graph part. @internal */
export interface NativePagedGraphPart {
  /** The first global vector number in the part. */
  first: number
  /** The number of vector positions in the part. */
  count: number
  /** Each node's number of layers, with zero for a missing node. */
  levels: Uint8Array
  /** Each node's byte offset in neighbours, followed by the end of the last node. */
  nodeOffsets: Uint32Array
  /** The counted uint32 neighbour lists. */
  neighbours: NativePageSection
}

/** The files and graph parts that describe one disk vector field. @internal */
export interface NativePagedVectorField {
  /** The number of float32 components in each vector. */
  dimension: number
  /** Zero for cosine, one for dot product, or two for Euclidean distance. */
  metric: number
  /** The number of vector positions across every file. */
  total: number
  /** The first node to visit, or null to choose a node on the highest layer. */
  entryPoint: number | null
  /** The highest permitted layer in the field. */
  maxLayer: number
  /** The OSQ width and centroid, or null for full-precision traversal. */
  codes: { bits: number; centroid: Float32Array } | null
  /** The vector files in gap-free global vector order. */
  files: readonly NativePagedVectorFile[]
  /** The graph parts in gap-free global vector order. */
  graphParts: readonly NativePagedGraphPart[]
}

/** The resolved search settings and admission masks of a paged vector query. @internal */
export interface NativePagedVectorRequest {
  /** The finite float32 query components. */
  query: Float32Array
  /** The result count before the host resolves document ID ties. */
  k: number
  /** The number of candidates that the graph walk retains. */
  ef: number
  /** The number of quantised candidates to score with full-precision vectors. */
  rescoreDepth: number
  /** Whether the caller supplied a rescore window. */
  explicitRescoreWindow: boolean
  /** The numeric score floor, including negative infinity. */
  minSimilarity: number
  /** The admitted global vector numbers in uint32 words, or null for every live vector. */
  accepted: Uint32Array | null
  /** The excluded global vector numbers in uint32 words, or null for none. */
  excluded: Uint32Array | null
}

/** The core operations that read checksummed pages and search disk vector fields. @internal */
export interface NativePagedCore {
  /**
   * Opens an immutable file for positional reads.
   * @param path - The path of the file to open.
   * @returns The open handle, or a negative status when the file cannot be opened.
   */
  openPagedFile(path: string): NativePagedFileHandle | number
  /**
   * Releases an open handle after every operation that uses it has finished.
   * @param file - The handle to close.
   * @returns Zero on success, or a negative status for an invalid handle.
   */
  closePagedFile(file: NativePagedFileHandle): number
  /**
   * Copies one verified page into the supplied output.
   * @param section - The file section to read.
   * @param cache - The calling thread's page cache, or null to retain no pages.
   * @param page - The page number within the section.
   * @param output - Receives the page bytes only after its checksum passes.
   * @param fault - Receives the file identity, section offset, and page number on a page failure.
   * @returns Zero on success, or a negative status that leaves output unchanged.
   */
  readPage(
    section: NativePageSection,
    cache: NativePageCache | null,
    page: bigint,
    output: Uint8Array,
    fault: BigUint64Array,
  ): number
  /**
   * Reads a verified page on a background thread while retaining its file until completion.
   * @param section - The file section, whose checksums the core copies before reading.
   * @param cache - An exclusively held cache with shared buffers, or null.
   * @param page - The page number within the section.
   * @param output - Shared bytes that receive the page after its checksum passes.
   * @param fault - Three shared uint64 words for the file identity, section offset, and page number.
   * @returns Zero on success, or a negative status, immediately on refusal or after completion.
   * A refusal leaves output unchanged.
   */
  readPageAsync(
    section: NativePageSection,
    cache: NativePageCache | null,
    page: bigint,
    output: Uint8Array,
    fault: BigUint64Array,
  ): number | Promise<number>
  /**
   * Copies a posting list after checking its pages, ordinals, fields, and order.
   * @param section - The paged postings section.
   * @param cache - The calling thread's page cache, or null to retain no pages.
   * @param first - The list's first posting offset.
   * @param count - The number of postings in the list.
   * @param documents - The segment's document count.
   * @param fields - The segment's field count.
   * @param output - Receives little-endian document, frequency, and field columns, occupying eight bytes per posting.
   * @param fault - Receives the file identity, section offset, and page number on a page failure.
   * @returns Zero on success, or a negative status that leaves output unchanged.
   */
  readPagedPostings(
    section: NativePageSection,
    cache: NativePageCache | null,
    first: number,
    count: number,
    documents: number,
    fields: number,
    output: Uint8Array,
    fault: BigUint64Array,
  ): number
  /**
   * Reads a posting list's positions and rebases its offsets to the returned values.
   * @param offsetSection - The section that holds absolute position offsets.
   * @param valueSection - The section that holds the uint32 positions.
   * @param cache - The calling thread's page cache, or null to retain no pages.
   * @param first - The first posting whose positions to read.
   * @param count - The number of postings to read.
   * @param offsets - Receives count plus one offsets relative to values.
   * @param values - Receives the positions after the core checks each posting's order.
   * @param fault - Receives the file identity, section offset, and page number on a page failure.
   * @returns Zero on success, or a negative status that leaves both output arrays unchanged.
   */
  readPagedPositions(
    offsetSection: NativePageSection,
    valueSection: NativePageSection,
    cache: NativePageCache | null,
    first: number,
    count: number,
    offsets: Uint32Array,
    values: Uint32Array,
    fault: BigUint64Array,
  ): number
  /**
   * Reads the sorted token and frequency pairs for one removed document.
   * @param offsetSection - The section that holds the document offsets in uint32 words.
   * @param valueSection - The section that holds token and frequency pairs.
   * @param cache - The calling thread's page cache, or null to retain no pages.
   * @param ordinal - The document ordinal within the segment.
   * @param tokens - The segment's token count.
   * @param values - Receives the token and frequency pairs after every check passes.
   * @param fault - Receives the file identity, section offset, and page number on a page failure.
   * @returns The number of uint32 words written, or a negative status that leaves values unchanged.
   */
  readPagedRemovals(
    offsetSection: NativePageSection,
    valueSection: NativePageSection,
    cache: NativePageCache | null,
    ordinal: number,
    tokens: number,
    values: Uint32Array,
    fault: BigUint64Array,
  ): number
  /**
   * Reads one document ID after checking its offsets, pages, and UTF-8 bytes.
   * @param offsetSection - The uint32 offsets into the ID section.
   * @param valueSection - The section that holds the UTF-8 IDs.
   * @param cache - The calling thread's page cache, or null to retain no pages.
   * @param ordinal - The document ordinal within the segment.
   * @param output - Receives the ID bytes after every check passes.
   * @param fault - Receives the file identity, section offset, and page number on a page failure.
   * @returns The ID length in bytes, or a negative status that leaves output unchanged.
   */
  readPagedId(
    offsetSection: NativePageSection,
    valueSection: NativePageSection,
    cache: NativePageCache | null,
    ordinal: number,
    output: Uint8Array,
    fault: BigUint64Array,
  ): number
  /**
   * Reads one ordinal from an ID order after checking its page and document range.
   * @param section - The section that holds one uint32 ordinal per document.
   * @param cache - The calling thread's page cache, or null to retain no pages.
   * @param position - The position within the ID order.
   * @param documents - The segment's document count.
   * @param output - Receives the ordinal in its first uint32 word.
   * @param fault - Receives the file identity, section offset, and page number on a page failure.
   * @returns Zero on success, or a negative status that leaves output unchanged.
   */
  readPagedOrdinal(
    section: NativePageSection,
    cache: NativePageCache | null,
    position: number,
    documents: number,
    output: Uint32Array,
    fault: BigUint64Array,
  ): number
  /**
   * Reads finite, non-negative term totals after checking every requested page.
   * @param section - The section that holds one float64 total per token.
   * @param cache - The calling thread's page cache, or null to retain no pages.
   * @param first - The first token whose total to read.
   * @param count - The number of consecutive totals to read.
   * @param output - Receives the totals after every value passes validation.
   * @param fault - Receives the file identity, section offset, and page number on a page failure.
   * @returns Zero on success, or a negative status that leaves output unchanged.
   */
  readPagedTotals(
    section: NativePageSection,
    cache: NativePageCache | null,
    first: number,
    count: number,
    output: Float64Array,
    fault: BigUint64Array,
  ): number
  /**
   * Reads a document's sequence number and primary term after checking both pages.
   * @param sequences - The section that holds the uint64 sequence numbers.
   * @param terms - The section that holds the uint64 primary terms.
   * @param cache - The calling thread's page cache, or null to retain no pages.
   * @param ordinal - The document ordinal within the segment.
   * @param output - Receives the sequence number and primary term in its first two words.
   * @param fault - Receives the file identity, section offset, and page number on a page failure.
   * @returns Zero on success, or a negative status that leaves output unchanged.
   */
  readPagedWriteRecord(
    sequences: NativePageSection,
    terms: NativePageSection,
    cache: NativePageCache | null,
    ordinal: number,
    output: BigUint64Array,
    fault: BigUint64Array,
  ): number
  /**
   * Searches a paged graph and retains every score tie at the requested cutoff.
   * @param field - The resident metadata and open file sections.
   * @param request - The query, resolved search settings, and admission masks.
   * @param cache - The calling thread's page cache, or null to retain no pages.
   * @param meter - The shared int64 work count followed by its cap.
   * @param stop - One uint32 that becomes one when the search stops.
   * @param deadline - One uint64 monotonic deadline, or zero for none.
   * @param ordinals - Receives the selected global vector numbers.
   * @param scores - Receives their relevance scores in descending score order.
   * @param fault - Receives the file identity, section offset, and page number on a page failure.
   * @returns The candidate count, or a negative status. Page failures, invalid arguments, allocation failures,
   * and short outputs preserve both candidate arrays. A stop or work-cap status leaves their contents undefined.
   */
  searchPagedVectors(
    field: NativePagedVectorField,
    request: NativePagedVectorRequest,
    cache: NativePageCache | null,
    meter: BigInt64Array,
    stop: Uint32Array,
    deadline: BigUint64Array,
    ordinals: Uint32Array,
    scores: Float64Array,
    fault: BigUint64Array,
  ): number
  /**
   * Searches disk vectors on a background thread while retaining the file handles until completion.
   * @param field - The resident metadata and open files, copied before the background search starts.
   * @param request - The query and admission regions, copied before the background search starts.
   * @param cache - An exclusively held cache whose regions use shared buffers, or null.
   * @param meter - The shared int64 work count followed by its cap.
   * @param stop - One shared uint32 that the caller can set atomically to stop the search.
   * @param deadline - One uint64 monotonic deadline, copied before the background search starts.
   * @param ordinals - A shared output region for selected global vector numbers.
   * @param scores - A shared output region for their scores.
   * @param fault - Three shared uint64 words for the file identity, section offset, and page number.
   * @returns The candidate count or a negative status, immediately on refusal or after completion.
   * Candidate output follows the same preservation rules as {@link NativePagedCore.searchPagedVectors}.
   */
  searchPagedVectorsAsync(
    field: NativePagedVectorField,
    request: NativePagedVectorRequest,
    cache: NativePageCache | null,
    meter: BigInt64Array,
    stop: Uint32Array,
    deadline: BigUint64Array,
    ordinals: Uint32Array,
    scores: Float64Array,
    fault: BigUint64Array,
  ): number | Promise<number>
}
