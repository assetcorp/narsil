# Narsil Native Core Specification

The native search core is the C library that [Native Search Core](vector-index.md#native-search-core) introduces for vectors. This document defines the operations that analyse text, match the words of a query, score keyword queries, evaluate filters, count facets, order sorted results, group hits, place pinned documents, page results, highlight hits, suggest terms, fuse hybrid rankings, merge results, and compute the maths functions that every implementation shares, together with the memory that each operation reads and writes.

An implementation must perform every operation in this document through the core wherever its platform can load native code. Where the platform cannot load native code, or where the deployment selects code written in the implementation's language, that code must return the same results, bit for bit, as the core returns for the same input, and it must raise the same error for the same input, which includes counting the same units of work.

---

## Memory

The implementation must allocate every region that this document defines, and the core must read and write each region in place, as [Shared Memory](vector-index.md#shared-memory) requires of a graph. Every value must be little-endian. An operation that finds too little room in a region must return `needsRoom` and leave every region unchanged, so that the implementation can grow the region at the same address and call the operation again.

The core may hold per-query scratch, such as a score buffer and the bounds of posting blocks, in a workspace that the core allocates and grows, and it may hold the scratch of analysis, such as the state of each stemmer, in an analyser of the same kind. A workspace and an analyser must each serve one thread at a time, and neither may hold index state, so that no copy of an index depends on scratch that another copy uses.

### One Writer per Copy

Each copy of an index has one writer thread for its keyword regions and its field regions, and the core takes no lock on those regions. The implementation must therefore let one thread at a time call an operation that writes them, and it must keep every search of a copy apart from a write to that copy, for example with a read-write lock, because the core reads those regions while a writer can be changing them. A frozen segment that several copies share is read-only, and each copy must record the removals that it applies in a separate [frozen segment state](#frozen-segment). The death of a thread therefore damages no copy other than the one that the thread wrote, so these regions need no record of held locks.

### Bitsets

A bitset holds one bit for each internal ordinal of a copy, in uint32 words. Ordinal `o` is bit `o AND 31` of word `o >> 5`, and a bitset of capacity `c` holds `max(1, ceil(c / 32))` words. The core must refuse an ordinal at or above the capacity of a bitset that it writes, because it must never write outside a region.

### Refusals

The core must refuse an argument outside its range and leave every region unchanged. That covers a missing region, a length that ends past the end of a region, an index or a flag outside its range, and text longer than 2^30 code units. An implementation must validate every request before it calls the core, and it must raise the code that this specification gives for a bad request, so that the core refuses only a request that the implementation built wrongly.

The core must also skip every value inside a region that points outside a region, such as an ordinal at or above the capacity of the segment, an offset beyond the end of the array that it indexes, and a slot of a hash table that holds an entry past its count, because a corrupt value could otherwise send the core outside a region.

### Tie Order

The core must compare present relevance scores by [Score Order](algorithms.md#score-order), including infinities, NaN, and signed zero. It must preserve the scores when it selects or merges entries.

The core holds no document ID. Wherever an operation breaks a tie on the document ID, the implementation must pass `idRanks`, which hold the position of each candidate among the candidates of that call in [code point order](algorithms.md#code-point-order), and the core must break the tie on that position.

### Work Meter

```text
WorkMeter {
  spent:    int64     (the units that the search has counted, across every thread)
  cap:      int64     (the work cap of Limits and Matching)
  stop:     uint32    (0, or 1 once the implementation stops the search)
  deadline: uint64    (a time of clockNow, or 0 for none)
}

clockNow() -> uint64
```

An operation that counts work must add its units to `spent` with an atomic addition, at least once for every 65,536 units that it counts and before it returns, so that every thread of one search reads one count. It must return `workCapExceeded` once `spent` exceeds `cap`, and the implementation must then raise `SEARCH_WORK_CAP_EXCEEDED`. It must return `stopped` once `stop` holds 1, or once `clockNow` passes a `deadline` above 0, checking both at least once for every 65,536 units, so that a request thread can move the search as [Request Threads](partitioning.md#request-threads) requires. An operation that returns either status leaves its output undefined, and the implementation must discard that output. The long-query thread must answer a moved search from the start with a new meter, so that it counts the search's work once and raises the same error as a search that never moved. `clockNow` returns nanoseconds of a monotonic clock, from an origin that only the core uses.

---

## Analysis

```text
languageCount() -> uint32
languageLookup(name: string) -> uint32 or 'unknown'
languageName(language: uint32) -> string
languageRevision(language: uint32) -> string
analyse(language: uint32, text: List<uint16>, flags, stopWords: StopWordSet or nil) -> List<Token>

flags: stem, removeStopWords, removeDiacritics, collectSurfaces

Token {
  position: uint32
  term:     List<uint16>
  surface:  List<uint16> or nil
  start:    uint32
  end:      uint32
}
```

The core holds every [LanguageModule](adapters.md#languagemodule) that the reference implementation publishes, and it numbers them in code point order of their names. `languageRevision` must return the `revision` of that module. The core holds no language module that a caller registers, so the implementation must analyse text in such a language with code written in the implementation's language.

`analyse` must follow steps 2 to 13 of [Analysis Pipeline](adapters.md#analysis-pipeline). Step 1 stays with the implementation, because a tokeniser that a caller configures replaces every later step. The core works on UTF-16 code units, so that its terms match the strings of an implementation whose strings are UTF-16, unit for unit. `analyse` must replace each lone surrogate of `term` and of `surface` with U+FFFD, because a segment stores its tokens in UTF-8, which holds no surrogate, and the implementation must do the same to each token that a custom tokeniser returns before it stores the token or looks it up. A document holds no lone surrogate, because [Documents](envelope.md#documents) refuses one, so for text that the core splits, the rule changes only the terms of a query.

`surface` holds the token as steps 11 and 12 leave it, before step 13 stems it, where the caller sets `collectSurfaces`, the caller sets `stem`, and the language has a stemmer. `surface` is nil in every other case, and nil where it equals `term`. `analyse` must drop a token that steps 8 to 13 leave empty.

`start` and `end` give the code units of `text` that the token came from, so that a highlighter can mark the token in the text as the caller wrote it. `start` is the place in `text` of the first code unit that steps 2 to 7 turned into the token's first code unit, and `end` is the place after the last code unit that they turned into its last code unit. Steps 2 to 5 can change the length of the text, so the core must carry the place of each code unit through those steps.

The implementation must call a stop word function where [Analysis Registry](adapters.md#analysis-registry) calls it, and pass the set that the function returns as `stopWords`. The core never calls back into the implementation.

---

## Keyword Segments

### Frozen Segment

A frozen segment holds the arrays of a [keyword segment payload](envelope.md#keyword-segment-payload), with the same types and the same order, plus these arrays, which each copy holds separately:

```text
FrozenSegmentState {
  tombstones:         bitset over the segment's ordinals
  tombstoneCount:     uint32
  removedDocuments:   uint32 per token
  removedOccurrences: float64 per token
  removedSurfaces:    uint32 per entry of surfaceForms
  removedSpellings:   uint32 per entry of partialWords
  pendingHeader:      uint32[8]            (word 0 the pending documents, word 1 the pending tokens, word 2 the pending units)
  pendingDocuments:   uint32 per pending document
  pendingTokens:      PendingToken per pending token
  pendingUnits:       uint16               (the code units that pendingTokens points into)
}

PendingToken {
  field:         uint32
  termOffset:    uint32
  termLength:    uint32
  surfaceOffset: uint32                    (0xFFFFFFFF where the token holds no surface)
  surfaceLength: uint32
}
```

`removedDocuments` holds, for each token, the documents that the copy removed from the segment and that hold the token, and `removedOccurrences` holds the sum of their term frequencies. `removedSurfaces` and `removedSpellings` hold the occurrences that those documents held of each surface form and of each written spelling. The core must subtract each of them from the count that it belongs to wherever it reads that count, and it must treat an entry whose count falls to 0 as absent.

`pendingDocuments` lists, in the order that the copy removed them, the tombstoned ordinals whose removal the four `removed` arrays do not yet hold, and `pendingTokens` holds the surface and spelling tokens of those documents. A state is settled where all three pending counts are 0. Before it lets an operation read a count of a frozen or a paged segment, which includes a lookup, a search, `measureMerge`, and `writeMerge`, the implementation must settle the copy's state with `settleFrozenState`, so that every operation that reads a count finds the state settled. To settle a state, the core adds each pending document to `removedDocuments` and `removedOccurrences`, from the segment's postings or, for a paged segment, from its `removals` entry, then adds each pending token to `removedSurfaces` and `removedSpellings`, and sets the three pending counts to 0. A settled state must hold the counts that removing the same documents one at a time would leave, in any order. `settleFrozenState` settles a state without reading a count, and the implementation must call it before it serializes a state or passes a state to another thread. Because settling writes the copy's state, the implementation must call `settleFrozenState` as it calls a write under [One Writer per Copy](#one-writer-per-copy), and it must open a search of a copy only once that copy's pending document count is 0, so that a search never settles a state.

### Paged Segment

A paged segment is a [paged keyword segment payload](envelope.md#paged-keyword-segment-payload) in a file. The implementation must give the core the resident sections in memory, as a frozen segment holds them, and an open handle to the file. The core must read each page of a paged section from the file into a page cache, which is a region that the implementation allocates for each thread that searches, so that one thread alone writes each cache. It must check the CRC32 of a page each time that it reads the page from the file, as [Checks on a paged segment](envelope.md#checks-on-a-paged-segment) requires, and it must return `pageCorrupt` with the section and the page where a check fails, which the implementation raises as `PERSISTENCE_CRC_MISMATCH`. It must return `pageUnreadable` where a read from the file fails or returns fewer bytes than the page holds, which the implementation raises as `PERSISTENCE_LOAD_FAILED`, because the core reads the file and never maps it, and a failed read from a mapping would end the process with a signal. The pages that a cache holds must change no result and no work count. The core must apply to each value that it reads from a page the rules of [Checks on a paged segment](envelope.md#checks-on-a-paged-segment), and it must return `pageInvalid` for a value that breaks them, which the implementation raises as `PERSISTENCE_LOAD_FAILED`. The core must read the documents of a paged segment through the implementation, because the implementation decompresses them and decodes them. A paged segment takes a [frozen segment state](#frozen-segment) like any frozen segment. The implementation must leave a segment file unchanged while a core holds it open, and it must detach every core from that file before it deletes the file.

### Paged Vector Field

```text
PageSection {
  file:      PagedFileHandle
  offset:    uint64
  length:    uint64
  pageBytes: uint32
  checksums: bytes
}

PagedVectorFile {
  first:   uint32
  count:   uint32
  dead:    bytes or nil
  vectors: PageSection
  records: PageSection or nil
}

PagedGraphPart {
  first:       uint32
  count:       uint32
  levels:      List<uint8>
  nodeOffsets: List<uint32>
  neighbours:  PageSection
}

PagedVectorField {
  dimension:  uint32
  metric:     cosine, dotProduct, or euclidean
  total:      uint32
  entryPoint: uint32 or nil
  maxLayer:   uint32
  codes:      { bits: uint32, centroid: List<float32> } or nil
  files:      List<PagedVectorFile>
  graphParts: List<PagedGraphPart>
}

searchPagedVectors(
  field: PagedVectorField,
  query: List<float32>,
  k: uint32,
  ef: uint32,
  rescoreDepth: uint32,
  explicitRescoreWindow: boolean,
  minSimilarity: float64,
  accepted: bitset or nil,
  excluded: bitset or nil,
  meter: WorkMeter
) -> List<{ ordinal: uint32, score: float64 }>
```

A `PagedFileHandle` is an open read-only file with a stable identity and a length. The core must read it by absolute position without changing a shared file position. `PageSection.offset` is the absolute byte offset from the start of that file. Its `pageBytes` and checksums must match a `Section` of the vector or graph payload in [Vector File Payload](envelope.md#vector-file-payload) or [Vector Graph Payload](envelope.md#vector-graph-payload). The checksums hold one little-endian uint32 per page. The core must refuse a section whose offset and length overflow or end after the file, whose page size is not 16,384 or 65,536, or whose checksum byte length differs from `4 * ceiling(length / pageBytes)`. A page fault must identify the file's stable identity, the section's absolute offset, and the page number, so that the implementation can report the file, section, and page.

The vector files must ascend by `first`, cover every number from 0 to `total` once with no gap, and hold no empty file. The `vectors` section of each file must hold exactly `count * dimension` float32 values. Where `codes` is present, its `bits` must be 1, 2, 4, or 8, its centroid must hold `dimension` values, and every file must hold one OSQ record per vector in `records`. Where `codes` is nil, every `records` section must be nil. A nil `dead` value marks every vector in that file live. Otherwise, `dead` holds one bit per local vector as [VectorFileRef](durability.md#manifest) defines, and the core must ignore its padding bits. The core must compute every range end and byte length without narrowing, and it must refuse an overflow.

The graph parts must ascend by `first`, cover every number from 0 to `total` once with no gap, and hold at most 16,384 numbers each. Every part before the last must hold 16,384 numbers. `levels` must hold `count` entries, and no entry may exceed `maxLayer + 1`. `maxLayer` must not exceed the limit in [HNSW](algorithms.md#hnsw-hierarchical-navigable-small-world). `nodeOffsets` must hold `count + 1` ascending entries whose first entry is 0 and whose last entry does not pass the length of `neighbours`. A level of 0 means that the vector has no node; every live vector must have a node. Each node must hold one neighbour list for every layer from 0 through its top layer, as [Vector Graph Payload](envelope.md#vector-graph-payload) defines. The core must skip a neighbour that has no node or whose top layer is below the list's layer, and it must return `pageInvalid` where a list ends after its node. An empty field must have no files or graph parts and a nil entry point. In a non-empty field, the entry point must be nil or below `total`; a nil entry point or one with no node makes the core start from a node on the highest layer.

The implementation must resolve the existing `efSearch`, oversampling, and rescore-window defaults before it calls `searchPagedVectors`. It must pass `ef` as at least `rescoreDepth`, and the core must refuse an `ef` of 0 for a non-empty search or a `rescoreDepth` above `ef`. The query must hold `dimension` finite values. `minSimilarity` must be finite or negative infinity. A call with `k` of 0 must validate the resident field structure and the other arguments, then return no candidates without reading a page.

The core must perform the complete upper-layer and base-layer walk of [HNSW Search](algorithms.md#search). Where `codes` is present, it must use [Optimised Scalar Quantisation](algorithms.md#optimised-scalar-quantisation-osq) for the walk and score the nearest `rescoreDepth` admitted candidates from their full-precision vectors. Where `codes` is nil, it must score every visited candidate from its full-precision vector. It must include an estimated candidate beyond `rescoreDepth` only where `explicitRescoreWindow` is true and `minSimilarity` is negative infinity. It must apply `minSimilarity` to every candidate that it returns.

The `accepted` and `excluded` bitsets use global vector numbers. A nil `accepted` bitset admits every live vector, and a nil `excluded` bitset excludes none. The core must admit a vector only where it is live, `accepted` admits it, and `excluded` does not exclude it. Admission controls which vectors the core can return, while the walk may pass through a vector that admission rejects. Each supplied bitset must cover `total` numbers, and the core must ignore its padding bits.

The core must return candidates by [Score Order](algorithms.md#score-order), highest first. Where at least `k` candidates remain, it must keep every further candidate whose score ties the score at place `k - 1`, so that the implementation can fetch their document IDs, break the tie in code point order, and then keep `k`. The returned list can therefore hold more than `k` entries, but it cannot hold more than `ef` entries.

For every neighbour list that it examines, the core must add the list's entry count times `dimension` to `meter`, including entries that it later skips. A cache hit, read-ahead, and the number of pages that one list crosses must not change that count. The core must use the statuses and output rules of [Work Meter](#work-meter) when the cap, stop flag, or deadline ends the search.

The implementation must allocate one page cache for each thread that calls the operation. The core may retain pages in that cache after a call. A cache entry must use the file's stable identity, the section's absolute offset, and the page number as its key, and every read from the file must check the page checksum before the cache can hold it. A `pageCorrupt`, `pageUnreadable`, `pageInvalid`, invalid-argument, out-of-memory, or `needsRoom` result must leave the candidate output unchanged. Work already added to the meter and pages already added to the cache may remain. The output of a stopped or work-capped call follows [Work Meter](#work-meter).

The implementation must keep the field, the query, both bitsets, the meter, the page cache, and every file handle alive until the operation returns. An asynchronous binding must retain them until the core has returned after completion or cancellation, and it must finish every argument and property access before native code retains a pointer.

### Growing Segment

```text
GrowingSegment {
  terms:       TermTable
  termColumns: TermColumns
  postings:    PostingPool
  positions:   PositionPool or nil
  surfaces:    SurfaceTable or nil
  spellings:   SpellingTable or nil
  retired:     bitset over the segment's ordinals
  fieldLength: uint32 per ordinal per field
  statistics:  SegmentStatistics
}

TermColumns {
  sliceStart:         uint32 per term
  sliceClass:         uint8 per term
  lengths:            uint32 per term
  docFrequency:       uint32 per term
  deadDocuments:      uint32 per term
  totalTermFrequency: float64 per term
  surfaceOccurrences: float64 per term   (the counts of the term's surface forms, summed)
  revision:           uint32 per term
  flags:              uint8 per term     (1 live, 2 ordered, 4 positions)
}

PostingPool {
  docIds:         uint32 per posting
  frequencies:    uint16 per posting
  fieldIndices:   uint16 per posting
  positionStarts: uint32 per posting, or nil
}

PositionPool {
  values: uint32   (each entry a count, then that many positions)
}

SegmentStatistics {
  totalDocuments:   uint32
  totalFieldLength: float64 per field
}
```

A writer must store the postings of one document for one token in adjacent entries, and it must keep them adjacent through every freeze and every merge, so that the core can add them in the order that [Score Arithmetic](algorithms.md#score-arithmetic) requires. The live document frequency of a term is `docFrequency` minus `deadDocuments`.

### Term Table

```text
TermTable {
  header:        uint32[8]
  slots:         int32[slotCapacity]    (the term ordinal plus 1, 0 where empty, or -1 where removed)
  termOffset:    uint32 per term
  termLength:    uint32 per term
  firstUnitNext: uint32 per term        (the next term with the same first unit, plus 1, or 0)
  firstUnitHead: uint32[65536]          (the first term with that first unit, plus 1, or 0)
  units:         uint16                 (the code units of every term)
}

TermTableHeader {
  word 0: count
  word 1: liveCount
  word 2: slotCapacity     (a power of two)
  word 3: generation
  word 4: unitsUsed
}
```

A term's slot starts at `termHash(term) AND (slotCapacity - 1)`, and a writer and a reader must probe the following slots in turn until they find the term or an empty slot. `termHash` is the [FNV-1a](algorithms.md#fnv-1a-hash) of the term's code units, each fed as two bytes with the low byte first. A writer must store -1 in the slot of a removed term, so that a probe passes it, and it must keep at least one slot empty, so that every probe ends. A writer that adds a term must probe as far as an empty slot before it reuses a slot that holds -1, so that it never adds a term twice. The [surface table](#surface-forms) and the [spelling table](#partial-words) use the same layout for their strings.

### Lookups

```text
lookupExact(segment, term: List<uint16>) -> uint32 or 'absent'
lookupExactBatch(segment, units: List<uint16>, offsets: List<uint32>) -> List<uint32 or 'absent'>
lookupPrefix(segment, prefix: List<uint16>, limit: uint32) -> List<uint32>
lookupTypo(segment, term: List<uint16>, tolerance: uint32, prefixLength: uint32) -> List<uint32>
documentFrequency(segment, token: uint32) -> uint32
```

`segment` is a growing, a frozen, or a paged segment, and a lookup returns term ordinals of a growing segment and token indexes of the others. `documentFrequency` returns the live document frequency, which for a frozen or a paged segment is `documentFrequencies` minus `removedDocuments`. Every lookup must return the same tokens, in the same order, for each kind of segment that holds the same documents.

Each lookup returns tokens whose live document frequency is above 0, and nothing else. `lookupPrefix` returns nothing for an empty prefix or a `limit` of 0. Otherwise, it must return the tokens whose code points start with `prefix`, ordered by live document frequency, highest first, and then in code point order, up to `limit`. `lookupTypo` must return `lookupExact` at a `tolerance` of 0. Otherwise, it must return, in code point order, the tokens that start with the first `prefixLength` code points of `term`, or with the whole of `term` where it holds fewer, and that lie within `tolerance` of `term` under [Bounded Levenshtein Distance](algorithms.md#bounded-levenshtein-distance).

`lookupExactBatch` must validate the segment once and apply `lookupExact` in order to each slice from `offsets[i]` through `offsets[i + 1]` of `units`. `offsets` must hold at least one entry, start with 0, ascend without decreasing, and end at the length of `units`. The result must hold one entry for each adjacent pair of offsets, using `UINT32_MAX` where that term is absent. An `offsets` value of `[0]` and empty `units` returns an empty result. The binding must require an output region of at least that result length, and the output must not overlap `units`, `offsets`, or a segment region. It must return the result length on success or an existing negative status on refusal, and a refusal must leave the whole output region unchanged, including where the segment, offsets, text slice, overlap, capacity, or allocation is invalid.

### Surface Forms

```text
SurfaceTable {
  strings: TermTable          (the surfaces)
  token:   uint32 per entry   (the term ordinal of the surface's token)
  count:   uint32 per entry
}
```

A growing segment holds its [surface forms](envelope.md#surface-forms) in a surface table, and a frozen or a paged segment holds them in its `surfaceForms` column. A writer must add the count of each surface that `indexTerms` receives and subtract the count of each surface that `removeDocument` receives, and it must remove an entry whose count falls to 0. It must keep `surfaceOccurrences` equal to the sum of the counts of each term's entries, so that the occurrences of a term as written are `totalTermFrequency` minus `surfaceOccurrences`.

### Partial Words

```text
SpellingTable {
  strings:    TermTable           (the written spellings)
  token:      uint32 per entry
  count:      uint32 per entry
  codePoints: uint32 per entry    (the spelling's length in code points)
  runs:       RunTable
}

RunTable {
  header:      uint32[8]           (word 0 count, word 2 slotCapacity, a power of two)
  slots:       int32[slotCapacity] (the run plus 1, 0 where empty, or -1 where removed)
  runs:        uint32 per run, three code points each
  listStart:   uint32 per run
  listLength:  uint32 per run
  listClass:   uint8 per run
  members:     uint32              (the members of every run, ascending within each run)
}
```

A growing segment holds the written spellings of [Partial-Word Search](algorithms.md#partial-word-search) in a spelling table, and a frozen or a paged segment holds them in its `partialWords` column. A writer must add an entry only for a spelling of more than three code points in a `partial` field, and it must keep each entry in the list of every run of three consecutive code points of the spelling. A run's slot starts at the FNV-1a of its three code points, each fed as four bytes with the low byte first, and a writer and a reader must probe as the term table does. A [pattern index](#pattern-index) uses the same run table for its runs.

### Segment Operations

```text
FieldTokens {
  field:  uint16
  tokens: List<Token>
}

indexTerms(segment, ordinal: uint32, fields: List<FieldTokens>) -> nothing or 'needsRoom' or 'segmentFull'
removeDocument(segment, ordinal: uint32, tokens: List<Token>) -> nothing
removeFrozenDocument(segment, state: FrozenSegmentState, ordinal: uint32, tokens: List<Token>) -> nothing or 'needsRoom'
settleFrozenState(segment, state: FrozenSegmentState) -> nothing
beginBatch(segment) -> nothing
endBatch(segment) -> nothing
measureMerge(inputs: List<segment>, mapping: List<uint32>) -> RegionSizes or 'segmentFull'
writeMerge(inputs: List<segment>, mapping: List<uint32>, target) -> nothing or 'segmentFull'
```

`indexTerms` must add the postings, the positions, the field lengths, the surface forms, the written spellings, and the statistics of one document. `fields` must hold each indexed text field at most once, in ascending field order. An empty `fields` list must still add the document to `totalDocuments`. `removeDocument` must take that document out of every count that a search reads. `removeFrozenDocument` must mark the document in `tombstones`, add 1 to `tombstoneCount`, append its ordinal to `pendingDocuments`, and append every token it receives to `pendingTokens`, and it must leave the four `removed` arrays to the settling that [Frozen Segment](#frozen-segment) describes. Where the ordinal or the tokens would not fit the pending regions, the core must settle the state first and then append them, and it must return `needsRoom`, before it changes any region, where they would not fit even in empty pending regions. `removeDocument` takes the tokens that `analyse` returns for the document with `collectSurfaces` set, so that it can subtract the surfaces and the spellings. `removeFrozenDocument` takes only those of the same tokens whose surface differs from its term or whose field is a `partial` field, in the order that `analyse` returns them, because the settling reads every term count from the postings and needs the tokens only for the surfaces and the spellings. Between `beginBatch` and `endBatch`, the core may defer the compaction of the term table, the pools, and the run lists, and `endBatch` must leave every count, list, and lookup result that a series of single writes would leave.

`measureMerge` must return the size of every region that the merged segment needs, so that the implementation can allocate them, and `writeMerge` must then fill them. `mapping` holds the target ordinal of each source ordinal, or `0xFFFFFFFF` for a dropped one. A merge must check every page of a paged input first, as [Checks on a paged segment](envelope.md#checks-on-a-paged-segment) requires.

A surface or spelling count belongs to one segment and must not pass `0xFFFFFFFF`. `indexTerms`, `measureMerge`, and `writeMerge` must leave every region unchanged and return `segmentFull` where the operation would make one of those counts larger. The implementation must freeze the growing segment and retry the complete document in a new growing segment when `indexTerms` returns `segmentFull`. It must split a merge into disjoint sets of kept source ordinals in original target-ordinal order, renumber each output from zero, and retry when either merge operation returns `segmentFull`, so that every source ordinal that the original mapping kept appears in exactly one output segment. It must publish none of those output segments until every split output succeeds. `segmentFull` is an internal capacity result and raises no client-facing error. `needsRoom` keeps the meaning in [Memory](#memory): the implementation grows the region that was too small at the same address and retries the same operation.

---

## Query Expansion

```text
expandPrefix(segments: List<segment>, typed: List<uint16>, stemmed: List<uint16>, own: List<uint16>) -> List<Member>
expandPartialWords(segments: List<segment>, requests: List<PartialRequest>) -> List<List<Member>>
expandSynonyms(table: SynonymTable, tokens: List<List<uint16>>) -> List<List<uint32>>

Member {
  token:  List<uint16>
  factor: float64
}

PartialRequest {
  written:      List<uint16>
  own:          List<uint16>
  share:        uint32
  tolerance:    uint32
  prefixLength: uint32
}
```

`segments` holds every segment of one partition, because every count below is a count over the partition. `expandPrefix` must collect the completions of [Prefix Completion](algorithms.md#prefix-completion) from the surface forms and the tokens of `segments`, keep the 50 that the most documents of the partition hold, breaking ties in code point order, and give each the factor of a completion in [Expanded Terms](algorithms.md#expanded-terms). `expandPartialWords` must answer each request as [Partial-Word Search](algorithms.md#partial-word-search) defines, giving each added word the factor of an added word, and the implementation must compute each request's `share` from the query words in query order. Both operations must compute the factor in binary64 as `a / b`, where `a` and `b` are the code point counts that Expanded Terms gives, and take `minimum(1, a / b)` for a completion.

```text
SynonymTable {
  tokens:      bytes                (each token in UTF-8, ascending)
  offsets:     uint32               (one value more than the token count)
  ruleStart:   uint32               (one value more than the rule count)
  ruleTokens:  uint32               (the token indexes of each rule)
  ruleSource:  int32 per rule       (the token of a one-way rule's word, or -1 for a two-way rule)
  tokenStart:  uint32               (one value more than the token count)
  tokenRules:  uint32               (for each token, the rules that it opens)
}
```

The implementation must analyse the words of a [synonym set](algorithms.md#synonyms) and build the synonym table, because a custom tokeniser can analyse them. A token opens a two-way rule that holds it, and the source token of a one-way rule opens that rule alone. `expandSynonyms` must take each query token once, in query order, and return the tokens of every other word in the rules that the token opens, in code point order without repeats. It must stop taking tokens once 50 of them have synonyms, and it must give each token with synonyms its share of the 50 as Synonyms defines, keeping the first synonyms in code point order.

The implementation must build the slots of [Keyword Score](#keyword-score) from these results. A query term's group holds the term's token with a factor of 1, its completions, and its added words, and a token that two of these add takes the larger factor. A synonym joins the term's combined term, and the implementation must take it out of the group's other members, so that a token that is both a synonym and a member counts as a synonym alone.

---

## Phrases

```text
matchPhrases(segment, phrases: List<Phrase>, searchable: List<uint8>, filter: bitset or nil, removed: bitset, meter: WorkMeter, collect: boolean) -> PhraseResult or 'workCapExceeded' or 'stopped'

Phrase {
  tokens:  List<uint32>   (token indexes or term ordinals, in phrase order)
  offsets: List<uint32>
}

PhraseResult {
  matched: bitset
  rows:    List<PhraseSlot rows>   (one list per phrase, in the order of phrases)
}
```

`matchPhrases` must match each phrase as [Phrase Search](algorithms.md#matching) defines, within one searchable field, and count `tf(P, f, D)` from the stored positions, as [Phrase Scoring](algorithms.md#phrase-scoring) requires. It must count the units of [Work Limit](algorithms.md#work-limit) into `meter`, and because the units depend on the order of the work, it must work in this order:

1. For each distinct token of every phrase, taking the phrases in request order and each phrase's tokens in phrase order, it must read the token's live postings once, and where they are out of document order, count one unit for each posting and put them in order by document. It must return an empty result at the first token that the segment lacks, because a phrase with that token matches no document there.
2. Within each phrase, the lead token is the token whose postings are fewest, the first in phrase order on a tie. It must take the phrases in ascending order of the posting count of their lead token, keeping the order of the request on a tie.
3. For each phrase, it must visit each posting of the lead token in order, counting one unit for each, and skip a posting in an unsearchable field, a document that `removed` holds, and a document outside the set that the previous phrase matched, or outside `filter` for the first phrase. For a posting that it keeps, it must find the posting of every other token in the same document and field, counting no unit, and move to the next posting of the lead token where one token lacks it.
4. For each position `p` of the lead token, in ascending order, with `a = p - leadOffset`, where `leadOffset` is the offset of the lead token in the phrase, and with `a` not below 0, it must advance a cursor through the positions of each token in phrase order to the first position not below `a + offset`, counting one unit for each position that it passes plus one for the position where it stops. It must stop counting starts for that posting once a cursor reaches the end of its positions, and it must count a start where every token holds the position that it needs.
5. It must stop after a phrase that matches no document.

`matched` holds the documents that match every phrase, and the implementation must pass it as the filter of [Keyword Score](#keyword-score), so that every hit holds every phrase. Where `collect` is set, `rows` holds for each phrase a row for each document and field where the phrase starts at least once, in the order of step 3.

---

## Keyword Score

```text
keywordScore(request: KeywordRequest) -> KeywordResult

KeywordRequest {
  slots:      List<Slot>     (in the order of Score Arithmetic)
  terms:      uint16         (the count of query terms)
  fields:     FieldScoring
  filter:     bitset or nil
  live:       bitset
  removed:    bitset         (the segment's retired or tombstoned ordinals)
  capacity:   uint32
  totalDocuments: uint32     (N of BM25, global under DFS)
  termMatch:  uint32         (the query terms that a hit must cover, 0 for 'any')
  anchor:     uint16         (under a termMatch equal to terms, the query term whose slots hold the fewest postings, the first in query order on a tie)
  limit:      uint32 or none
  minScore:   float64 or none
  collect:    boolean        (whether to return the matched ordinals)
}

Slot = TermSlot or GroupSlot or PhraseSlot

TermSlot {
  term:  uint16              (the query term)
  lists: List<PostingList>   (the term's matches in code point order)
}

PostingList {
  docIds:      List<uint32>
  frequencies: List<uint16>
  fields:      List<uint16>
  documentFrequency: uint32   (n of BM25 for this token)
  ordered:     boolean
}

GroupSlot {
  term:    uint16
  documentFrequency: uint32   (the largest n over the group's tokens)
  members: List<{ factor: float64, partialFactor: float64, rows: GroupRows }>
}

GroupRows {
  docIds:      List<uint32>
  frequencies: List<uint16> or List<float64>
  fields:      List<uint16>
}

PhraseSlot {
  documentFrequencies: List<uint32>   (n of each token of the phrase, in phrase order)
  rows: List<{ doc: uint32, field: uint16, frequency: uint32 }>
}

FieldScoring {
  searchable:     uint8 per field
  partialMarks:   uint8 per field
  nameRanks:      uint16 per field   (the position of the field's name in code point order)
  boosts:         float64 per field
  averageLengths: float64 per field
  lengths:        one uint32 column per field, or nil for the average length
  k1:             float64 per field
  b:              float64 per field
}

KeywordResult {
  ordinals:     List<int32>
  scores:       List<float64>
  totalMatched: uint32
  matched:      bitset or nil
}
```

`keywordScore` must score each document by [BM25](algorithms.md#bm25-best-matching-25), adding the contribution of each slot in the order of the request, as [Score Arithmetic](algorithms.md#score-arithmetic) defines. A group slot must add the largest member sum once, taking the first member's sum where two sums are equal. A member must use `partialFactor` in a field whose `partialMarks` entry holds 1, and `factor` in every other field. A group's frequencies can be float64, because a synonym row sums the frequencies of every synonym in one field, so the sum can pass 65,535. The core must score a document only where `live` holds it and `removed` lacks it, because an update that leaves a document with no text retires its rows while the document stays live. It must compute every IDF from `totalDocuments` and the document frequencies of the request, and it must add a document's rows for one token in the order of their `nameRanks`.

A document covers a query term where it holds a row of a slot of that term whose factor in the row's field is above 0, and every row of a term slot counts. A phrase slot covers no term. Where `termMatch` and `terms` are both above 0, the core must keep only the documents that cover at least `termMatch` terms, and it must keep none where `termMatch` exceeds `terms`. A query with no words takes no coverage test, as [Matching](algorithms.md#matching) requires. The implementation must count each distinct query token as one term. Where `termMatch` equals `terms`, the core may first mark the documents of the slots of the `anchor` term and score only those, because every kept document covers that term.

The core must then keep a document whose score is at least `minScore` where `minScore` is above 0, and every remaining document otherwise. A NaN score fails that numeric lower-bound test. It must return the `limit` best ordinals in [Score Order](algorithms.md#score-order), plus every further ordinal that ties the score of the last one that it keeps, so that the implementation can break those ties on the document ID. A NaN cutoff therefore keeps every NaN candidate. Where `limit` is 0, the core must return no ordinals. Where `limit` is none, it must return every document that it keeps. `totalMatched` counts every document that passes the coverage and score tests, before the limit applies.

The core must compute IDF through the natural logarithm of [Deterministic Functions](algorithms.md#deterministic-functions).

---

## Field Indexes

Each region below holds the field index of one field in one segment.

```text
NumericIndex {
  count:    uint32
  values:   float64[count]   (ascending)
  ordinals: uint32[count]
}

BooleanIndex {
  trueBits:  bitset
  falseBits: bitset
}

EnumIndex {
  count:          uint32
  units:          uint16                 (the code units of every value)
  offsets:        uint32[count + 1]
  postingOffsets: uint32[count + 1]
  postings:       uint32                 (the ordinals that hold each value)
  suffixOrder:    uint32[count]          (value indices in order of their reversed code units)
}

GeoIndex {
  count:    uint32
  codes:    uint64[count]
  lat:      float64[count]
  lon:      float64[count]
  ordinals: uint32[count]
}
```

A numeric index holds one entry for each element of a document's value, so a document whose value is `[3, 3]` holds two entries, and the order of entries with equal values is free. It also serves the size index of a `string`, `verbatim`, or list field. A boolean index can hold an ordinal in both bitsets, because a `boolean[]` value can hold both values. An enum index must order its values by UTF-16 code unit. A geo index holds one entry for each document, ordered by `codes` and then by ordinal, where a code interleaves the 26-bit latitude cell and the 26-bit longitude cell of the point, with the latitude bit above the longitude bit in each pair.

The implementation must also pass a present bitset for each field, which marks the ordinals that hold a value for that field, and the live bitset of the copy.

### Stored Values

```text
StoredValues {
  shapes:  uint8 per ordinal           (0 absent, 1 one value, 2 an array)
  starts:  uint32 per ordinal, plus 1  (each document's first value)
  kinds:   uint8 per value             (0 null, 1 false, 2 true, 3 number, 4 string, 5 other)
  numbers: float64 per value           (the number of a number value)
  textStart:  uint32 per value         (the first code unit of a string value, or the first byte of an other value)
  textLength: uint32 per value
  units:   uint16                      (the code units of every string value)
  bytes:   uint8                       (the MessagePack encoding of every other value)
}
```

A stored-values region holds, for one field of one segment, the values that each document stores in the field, in their stored order, with an array taken element by element and a value that is not an array taken as one element. A document that holds no value in the field holds no value in the region, and `shapes` records whether it held one value or an array, so that `"a"` and `["a"]` stay apart. `other` marks an object or a nested array, which the region holds as its MessagePack encoding. A growing segment fills this region on each write. A frozen or a paged segment fills it from its documents the first time that a search reads the field, so that opening a paged segment reads no document, and later searches read the values of a document without the implementation decoding it. The implementation must keep a stored-values region for every field that a facet, a group, a pattern test, or a sort reads, and for no other field.

### Sort Columns

```text
SortValues {
  kinds:      uint8 per entry       (0 missing, 1 number, 2 string, 3 false, 4 true)
  numbers:    float64 per entry
  textStart:  uint32 per entry
  textLength: uint32 per entry      (at most 512 code points)
  units:      uint16                (the code units of every string)
}

SortColumn {
  current: SortValues               (one entry per ordinal)
  values:  SortValues               (the distinct values of the order, ascending in sort value order)
  ranks:   int32 per ordinal
  ordered: uint32                   (the present ordinals, ascending by rank)
  dirty:   bitset                   (the ordinals written since the order was built)
}

buildSortOrder(column, live: bitset) -> nothing or 'needsRoom'
sortValue(values: StoredValues, ordinal: uint32, mode) -> the sort value
```

A sort column holds the sort value of each ordinal for one field and one mode, as [Sort Value Order](algorithms.md#sort-value-order) reduces a value under `min`, `max`, `avg`, or `median`, and `sortValue` must compute that value from the stored values. `buildSortOrder` must order the distinct values of the live ordinals, give a value at index `i` the rank `2 * i + 2`, fill `ordered`, and clear `dirty`. An ordinal in `dirty` takes the rank of its value in `values` where `values` holds it, and otherwise the odd rank between its neighbours. The implementation must call `buildSortOrder` before a search reads the column once `dirty` holds more than `maximum(1024, floor(live / 4))` ordinals, where `live` counts the live documents of the copy, so that a search compares few values outside the order.

```text
textRange(column, lower: string or nil, lowerInclusive, upper: string or nil, upperInclusive, live: bitset) -> bitset
```

`textRange` must answer a range test on text, as [Where Each Order Applies](algorithms.md#where-each-order-applies) defines, by comparing the sort value of each ordinal with the first 512 code points of each bound in sort value order. A missing value lies outside every range.

---

## Filters

```text
evaluateFilter(plan: List<Instruction>, operands: Operands, regions, live: bitset) -> bitset

Instruction {
  opcode:   uint32   (TEST, AND, OR, NOT, ANDNOT, PRESENT, or BITSET)
  field:    uint32
  operator: uint32
  operand:  uint32
}

Operands {
  numbers:     List<float64>
  units:       List<uint16>
  offsets:     List<uint32>
  stringLists: List<{ first: uint32, count: uint32 }>
  bitsets:     List<bitset>
}
```

The core must evaluate the plan as a postfix program over a stack of bitsets. `TEST` pushes the result of one test. `AND n` and `OR n`, where `n` is at least 1, pop `n` bitsets and push their intersection or their union. `NOT` pops one bitset and pushes `live` minus it. `ANDNOT` pops `b`, then `a`, and pushes `a` minus `b`. `PRESENT` pushes the present bitset of the field. `BITSET` pushes an operand bitset. An empty plan gives `live`.

The implementation must express `ne`, `nin`, `exists`, `notExists`, `isEmpty`, `isNotEmpty`, `containsAll`, `matchesAny`, and a geo test whose `inside` is false through these instructions. A test on a field that has no index gives the empty set. A pattern test and a range test on text reach the plan as `BITSET`, and the implementation must compute those bitsets through [`patternTest`](#pattern-tests) and [`textRange`](#sort-columns) before it evaluates the plan.

A numeric test must select a span of entries, where `lower(v)` is the first entry whose value is not below `v`, and `upper(v)` is the first entry whose value is above `v`:

| Operator | Entries |
|----------|---------|
| `eq` | from `lower(v)` to before `upper(v)` |
| `gt` | from `upper(v)` to the end |
| `gte` | from `lower(v)` to the end |
| `lt` | from the start to before `lower(v)` |
| `lte` | from the start to before `upper(v)` |
| `between` | from `lower(lo)` to before `upper(hi)` |

A boolean `eq` takes 0 or 1. An enum `eq`, `in`, `startsWith`, or `endsWith` takes strings from `units` and `offsets`, and the core must search the values for them, using `suffixOrder` for `endsWith`.

Two operators take a list from `numbers` or from `stringLists`. `anyOf` gives the union of the `eq` results of the list's items, and it serves `in`, `matchesAny`, and, with `PRESENT` and `ANDNOT`, `nin`. `allOf` gives their intersection, and it serves `containsAll`. Each test of a filter therefore becomes one `TEST` instruction, together with at most one `PRESENT`, one `ANDNOT`, and one `NOT`.

A geo radius test takes `[lat, lon, metres, highPrecision]`. The core must read the cells that cover the circle, and keep an entry whose [Haversine](algorithms.md#haversine-distance) distance, or whose [Vincenty](algorithms.md#vincenty-distance) distance where `highPrecision` is 1, is at most `metres`. A geo polygon test takes `[count, lat0, lon0, ...]`, and the core must keep an entry that [ray casting](algorithms.md#point-in-polygon-ray-casting) places inside.

Before it builds a plan, the implementation must raise `SEARCH_INVALID_FILTER` for a filter that nests more than 30 deep, that holds more than 1,024 tests, or that gives a list operand of more than 65,536 items. The core must refuse a plan that empties the stack, that leaves other than one bitset at the end, that refers to a field or an operand out of range, that holds more than 1,024 `TEST` instructions, or that holds more than 100,352 instructions in all. A filter that the implementation accepts holds at most 31,744 expressions, because every leaf counts at least one test and every path from the root to a leaf holds at most 31 expressions. Each test adds at most 4 instructions, each field at most 1 more, and each expression at most 3, so a plan holds at most 4 × 1,024 + 1,024 + 3 × 31,744 = 100,352 instructions.

### Pattern Index

A growing segment holds the [pattern index](algorithms.md#pattern-index) of a pattern field in a [run table](#partial-words) whose members are ordinals, plus a list of the ordinals that hold a value in the field, ascending. A frozen or a paged segment holds it in its `pattern` column. A writer must take the runs from the [case fold](algorithms.md#case-folding) of each value, and it must list an ordinal once in each run that any of its values holds. A reader takes a run's list as the ordinals that it holds, ascending, so a growing segment must drop the ordinals of removed documents from a list before the core reads it, while a frozen segment keeps the ordinals of its tombstoned documents.

### Pattern Tests

```text
patternTest(index, values: StoredValues, test: PatternTest, meter: WorkMeter, into: bitset) -> nothing or 'workCapExceeded' or 'stopped'

PatternTest {
  operator:  eq, startsWith, endsWith, contains, wildcard, or regex
  text:      List<uint16>
  caseFold:  boolean
  tolerance: 0, 1, 2, or auto
}
```

The core holds the case fold table of [Case Folding](algorithms.md#case-folding). `patternTest` must set in `into` each ordinal whose stored value matches the test as [Pattern Search](algorithms.md#pattern-search) defines, and the implementation must validate the test and raise its errors before it calls the core. The core must count the work of the test into `meter` as [Limits and Matching](algorithms.md#limits-and-matching) and [Typo Test](algorithms.md#typo-test) define. The units depend on the runs that the core takes for its shortlist, so it must take them as follows.

1. A literal test takes one factor, the fold of `text`, whatever `caseFold` holds. An expression takes its factors from its parsed form: consecutive literals, each folded, form one factor, a group or a repeat of exactly once adds its body to the current factor, an anchor or `\b` adds nothing, and every other atom ends the current factor. A repeat with a minimum of 1 or more ends the current factor, adds its body as a separate factor, and ends that one too, while any other repeat ends the current factor alone. A factor of fewer than 3 code points holds no run. An expression whose top level is a choice takes the factors of each branch separately, and it takes no runs where one branch holds none.
2. Where the factors hold `T` runs in all, counted with repeats, the core must pick `min(T, 16)` of them. Pick `i` takes the run at place `round(i * (T - 1) / (picks - 1))` among the runs of the factors in order, or place 0 where it picks one, where `round` takes a half upwards. It must skip a pick that repeats an earlier run.
3. For one set of picked runs, the core must count one unit for each run and read its list, order the lists by length, shortest first and in pick order on a tie, take the first list as the candidates, and count one unit for each candidate. It must then take each further list in turn while the candidates are not empty, stopping at a list longer than 8 times the candidates, and keep the candidates that the list holds, counting `min(length, r + 1)` units, where `r` is the place in the list at which its comparison with the candidates ended. A choice takes the union of the candidates of its branches.
4. Without runs, the candidates are every ordinal that holds a value, and the core must count one unit for each candidate that `into` lacks.
5. The core must test the values of each candidate that `into` lacks, in stored order, stopping at the first value that matches, and it must count the steps of each value until its matcher can reach no further position.

A typo test must fold `text`, count its preparation once for the search, find the distinct runs of the folded text, and take the shortlist from the `k * (2 + f) + 1` of them whose lists are shortest, with `k` and `f` as Typo Test defines them and pick order deciding a tie. Where the folded text holds `p` runs and `L` is the larger of 16 and `2 * (2 + f) + 1`, the distinct runs are the runs at the places `round(i * (p - 1) / (L - 1))` for `i` from 0 to `L - 1` where `p` exceeds `L`, followed by the runs in order from place 0, until `L` distinct runs are kept, and each run that the core checks counts one unit. A test whose tolerance resolves to 0 is an `eq` test. The core must count one unit for each distinct run and read its list, count each list of the shortlist in full, and test each candidate once across those lists. It must skip, with no step, a value whose folded length, or whose length under no `caseFold`, differs from that of the text by more than `k`. For any other value, it must fill row `i` of the distance table from column `maximum(1, i - k)` to column `minimum(n, i + k)`, counting one step for each cell, and stop after the first row whose cells all exceed `k`.

---

## Facets

```text
numberFacet(index: NumericIndex, matched: bitset) -> { values: List<float64>, counts: List<uint32> }
rangeFacet(index: NumericIndex, matched: bitset, ranges: List<float64>) -> List<uint32>
storedRangeFacet(values: StoredValues, matched: bitset, ranges: List<float64>) -> List<uint32>
enumFacet(index: EnumIndex, matched: bitset) -> List<uint32>
booleanFacet(index: BooleanIndex, matched: bitset) -> { trueCount: uint32, falseCount: uint32 }
valueFacet(values: StoredValues, matched: bitset) -> List<{ value: uint32, count: uint32 }>
```

`numberFacet` must return each distinct value with the number of matched documents that hold it, in ascending order of value, so that a document counts once for each distinct value that it holds, where -0 and 0 are one value. `rangeFacet` takes `from` and `to` for each range, and it must count the matched documents that hold an entry from `lower(from)` to before `lower(to)`, giving 0 for a range with a NaN bound. `storedRangeFacet` must count each matched document once in each range where its scalar number, or one of the direct number elements of its array, is at least `from` and below `to`. It must skip a null, a boolean, a string, an `other` value, and every non-number element of an array. A NaN value matches no range, and a range with a NaN bound has a count of 0. `enumFacet` must return a count for each value index. `valueFacet` must count a field that has no index from its stored values, counting each element of a matched document once and skipping a null and an `other` value, because neither has a bucket key, and it must return one entry for each distinct value, which gives the place of the first stored value that holds it. A number and a string with the same text are two values, and the implementation must give them one bucket where their keys are equal.

The implementation must turn each value into its bucket key, writing a number the way ECMAScript converts a number to a string, order the buckets, apply the limit, and compute the error bound, as [Distributed Facets](distribution/query-routing.md#distributed-facets) defines.

---

## Sort

```text
sortSelect(
  columns: List<{ column: SortColumn, direction }>,
  filter: bitset,
  live: bitset,
  limit: uint32,
  anchor: { ranks: List<int32>, values: SortValues } or nil
) -> List<uint32>
```

A rank of -1 marks a missing value, and a missing value orders last in both directions, while `desc` reverses every other rank. To compare two ordinals, `sortSelect` must visit the columns in the order in which the sort names them. In each column it must compare the ranks first. Where equal ranks are odd, it must compare the two current values under that column's direction before it visits the next column. The first rank or value comparison that differs decides the order. Ordinals whose ranks and, for every odd rank, current values are equal in every column share one complete sort key.

`sortSelect` must return the `limit` best ordinals in that order, plus every further ordinal whose complete sort key equals the complete sort key of the last one that it keeps. The implementation must order ordinals that share one complete sort key by document ID.

Where a cursor gives an anchor, the implementation must pass the reduced anchor value and its rank for every column. The core must compare an ordinal with the anchor through the same field-by-field rule and keep every complete sort key that is equal to or after the anchor. The implementation must drop an ordinal whose complete sort key equals the anchor's where its document ID is not after the anchor's. Where that removal leaves a short page and the core may have omitted a later complete sort key, the implementation must call `sortSelect` with a larger limit until the page is full or the core has returned every remaining ordinal.

---

## Groups

```text
groupHits(values: List<StoredValues>, ordinals: List<uint32>, scores: List<float64>, idRanks: List<uint32>, maxPerGroup: uint32, limit: uint32 or none) -> List<Group>

Group {
  hits:    List<uint32>   (indices into the input, at most maxPerGroup)
  members: uint32
}
```

The implementation must pass the hits in final order. `groupHits` must put two hits in one group exactly where the stored values of every group field, in field order, are equal. Two values are equal where they have the same shape and the same elements in the same order, comparing numbers by value with -0 equal to 0, strings by code unit, and `other` values by their bytes, and the core must treat an absent value as a null. A hit with no score takes 0. It must order the groups by the score of their first hit, highest first, and then by the `idRanks` entry of that hit. The implementation must call a group's reducer, because a reducer is a caller's function.

For grouping equality, the core must treat every NaN number as equal to every other NaN number, regardless of its sign or payload bits. A NaN number differs from every finite number, both infinities, null, and an absent value. Positive infinity equals only positive infinity, and negative infinity equals only negative infinity. These rules apply to values whose `kind` is number, including the elements of an array; `other` values retain byte equality. Grouping must leave every input value and its stored bytes unchanged, including NaN payload bits.

---

## Pinned Documents and Pages

```text
placePinned(count: uint32, pins: List<{ ranked: int32, position: uint32 }>, depth: uint32 or none) -> List<int32>
pageStart(count: uint32, sorted: boolean, scores: List<float64> or nil, scorePresent: bitset or nil, afterAnchor: bitset, anchorScore: float64 or nil) -> uint32
```

`placePinned` must place [pinned documents](distribution/query-routing.md#pinned-documents) into a ranked list of `count` entries. The implementation must pass each pin once, at its first listed position, and leave out a pin whose document no segment holds. `ranked` gives the pin's place in the ranked list, or -1 where the list lacks it. The core must remove every ranked pin from the list, take the pins in ascending order of `position`, keeping the order of the request on a tie, and insert each one at `minimum(position, length)` of the list as it then stands. Where `depth` is not none, it must skip a pin whose position is at or beyond `depth`, because a merge that lacks some matches cannot place the end of the results. It returns each entry as its index in the ranked list, or as `-1 - p` for pin `p`. `count` and the number of pins must each be at most 2^31 - 1, so that every returned entry fits an int32, and the core must refuse a larger value as [Refusals](#refusals) requires.

`pageStart` must return the place of the first result after a [cursor](partitioning.md#deep-pagination)'s anchor, or `count` where no result orders after it. `count` gives the number of results in their final order, so an empty list returns 0. The bitsets use result positions, with the word layout of [Bitsets](#bitsets), and the core must ignore bits at or above `count`.

Where `scores` is nil, every result holds no score and `scorePresent` must be nil. Otherwise, `scores` must hold exactly `count` entries, and a nil `scorePresent` means that every score is present. A set bit in `scorePresent` marks a present score, and a clear bit marks an absent score whose array entry the core must not read. Zero is a present score wherever its bit is set. `afterAnchor` and a supplied `scorePresent` must each hold at least `max(1, ceil(count / 32))` uint32 words. The core must refuse a shorter region, a scores length that differs from `count`, or a supplied `scorePresent` with nil `scores`, as [Refusals](#refusals) requires.

Where `sorted` is false, a result orders after the anchor where `anchorScore` is nil, where the result holds no score, where its score ranks below `anchorScore` under [Score Order](algorithms.md#score-order), or where the scores tie under that order and `afterAnchor` holds it. Where `sorted` is true, `afterAnchor` alone decides, regardless of score presence or value. The implementation must set a result in `afterAnchor` where its document ID orders after the anchor's without a sort, or where its sort values, and then its document ID, order after the anchor's with a sort. The implementation must validate the cursor before calling the core, slice the page from the returned place plus the offset, and anchor the next cursor on the last result of the page that is not a pinned placement. A request without a cursor starts at place 0 without calling `pageStart`.

---

## Highlighting

```text
highlight(language: uint32, text: List<uint16>, query: HighlightQuery, preTag: List<uint16>, postTag: List<uint16>, maxSnippetLength: uint32) -> { snippet: List<uint16>, positions: List<{ start: uint32, end: uint32 }> }

HighlightQuery {
  terms:        List<{ term: List<uint16>, tolerance: uint32 }>   (the stemmed query tokens)
  prefixLength: uint32
  prefix:       List<uint16> or nil    (the unstemmed last word of a prefix query)
  synonyms:     List<List<uint16>>     (the synonyms of the query, plus every phrase token)
  partialWords: List<List<uint16>> or nil
}
```

`highlight` must analyse `text` with the language, with stemming off and with every stop word kept, whatever tokeniser the index sets. It must mark a token where `prefix` is set and the token starts with it, where `partialWords` is set and the [written spelling](algorithms.md#partial-word-search) at the token's position is longer than one of those words and holds it, or where the stem of the token is one of `synonyms` or matches a term as [Bounded Levenshtein Distance](algorithms.md#bounded-levenshtein-distance) accepts under the term's `tolerance` and `prefixLength`. The implementation must give the last word of a prefix query a tolerance of 0. A marked token covers the code units from its `start` to its `end`, and the core must join every two marked spans that overlap or touch.

Where no span is marked, `snippet` holds `text`, cut to its first `maxSnippetLength` code units and followed by `...` where `maxSnippetLength` is above 0 and `text` is longer. Where `maxSnippetLength` is 0 or `text` is no longer, `snippet` holds `text` with `preTag` before each span and `postTag` after it, and `positions` holds every span. Otherwise the core must choose a window of `maxSnippetLength` code units. For each span in order, a candidate window starts at `max(0, start - floor(maxSnippetLength / 2))`, ends `maxSnippetLength` units later or at the end of `text`, and moves back to start `maxSnippetLength` units before its end where it can. The core must take the first candidate that holds the most spans whole, or the window at the start of `text` where no candidate holds a span whole. `snippet` then holds the window with tags around each span inside it, starting with `...` where the window starts after the start of `text` and ending with `...` where the window ends before the end of `text`, and `positions` holds the spans inside the window, counted from the start of `text`. Wherever the core cuts `text`, it must move an edge that falls between the two units of a surrogate pair outwards to the edge of the pair, so that a snippet holds no lone surrogate.

---

## Term Suggestions

```text
suggestTerms(segments: List<segment>, typed: List<uint16>, stemmed: List<uint16>, limit: uint32) -> List<Suggestion>

Suggestion {
  token:             List<uint16>
  documentFrequency: uint32
  spellings:         List<{ spelling: List<uint16>, occurrences: float64 }>
}
```

`suggestTerms` must answer a term suggestion from the segments of one partition, and it returns nothing for an empty `typed` or a `limit` of 0. In each segment, it must collect each surface form that starts with `typed` and whose token holds a live document, with the surface's count. It must then collect each token that starts with `typed` and occurs at least once as written, as [Surface Forms](envelope.md#surface-forms) derives that count, with the token itself as a spelling and that count, unless the segment already collected the token as one of its surfaces. Where the segment holds no surface forms and `stemmed` is not empty and differs from `typed`, it must also collect in that way each token that starts with `stemmed`. It must sum each token's live document frequency over the segments that collect it, and each spelling's occurrences over the segments. It must order a token's spellings by occurrences, highest first, and then in code point order, order the tokens by document frequency, highest first, and then in code point order, and return the first `limit`. The implementation shows a token through its first spelling, and the coordinator merges the suggestions of several nodes as [the suggestion request](distribution/transport.md#querysuggest) defines.

---

## Fusion

```text
fuse(strategy, k: float64, alpha: float64, text: List<{ key: uint32, score: float64 }>, vector: List<{ key: uint32, score: float64 }>, idRanks: List<uint32>) -> List<{ key: uint32, score: float64 }>
```

`fuse` must compute [Reciprocal Rank Fusion](algorithms.md#reciprocal-rank-fusion) or the [Linear Combination](vector-index.md#linear-combination), including its treatment of infinities, NaN, and a subtraction that overflows. Under the linear combination, it must normalise each list separately and give 0 to a key that a list lacks. It must order the result by score, highest first, and then by `idRanks`. The implementation must validate `k` and `alpha` and raise `CONFIG_INVALID` for a bad value. Each key must appear at most once in each list, and the core must refuse a key that repeats within one list.

---

## Merges

```text
mergeRankings(lists: List<{ scores: List<float64>, idRanks: List<uint32> }>, limit: uint32) -> List<{ list: uint32, index: uint32 }>
mergeSorted(lists: List<{ ranks: List<uint32> }>, limit: uint32) -> List<{ list: uint32, index: uint32 }>
mergeFacets(lists: List<List<{ value: uint32, count: uint32 }>>, bounds: List<uint32>, valueRanks: List<uint32>, ascending: boolean, limit: uint32 or none) -> { buckets: List<{ value: uint32, count: uint32 }>, errorBound: uint32 }
mergeGroups(lists: List<List<{ key: uint32, entries: List<{ score: float64 or none, rank: uint32, idRank: uint32 }> }>>, sorted: boolean, maxPerGroup: uint32, limit: uint32 or none) -> List<{ key: uint32, entries: List<{ list: uint32, index: uint32 }> }>
measureFieldMerge(sources, mapping: List<uint32>) -> RegionSizes
writeFieldMerge(sources, mapping: List<uint32>, targets) -> nothing
```

`mergeRankings` must merge lists that each follow [Score Order](algorithms.md#score-order), with ties ordered by `idRanks`, into one list of at most `limit` entries under that same order. It must keep list order where both the score class and `idRanks` are equal, including ties among NaNs. An empty input or a limit of 0 produces an empty list. `mergeSorted` must merge lists that are each ordered by sort value into one list ordered by `ranks`, where the implementation gives every entry its place among the entries of every list in [sort value order](algorithms.md#sort-value-order), and then in code point order of document ID. Both serve the merge across segments, partitions, and nodes.

`mergeFacets` must sum the counts of each value across the lists, order the values by count, highest first or lowest first where `ascending` is set, and then by `valueRanks`, which hold the place of each value's bucket key in code point order, and keep the first `limit`. Its `errorBound` must be the sum of `bounds` plus the largest count that it leaves out, as [Distributed Facets](distribution/query-routing.md#distributed-facets) defines. The implementation must give one value the same number in every list.

`mergeGroups` must merge the groups that share a key, which the implementation assigns from the groups' field values in field order. Where `sorted` is true, it must merge each group's entries as `mergeSorted` merges them, even where they hold scores. In that case, `rank` gives each entry's place across every input list by sort values and then document ID. Where `sorted` is false, `rank` must equal `idRank`, and the core must merge entries as `mergeRankings` merges them, treating an absent score as negative infinity for that merge alone. Each input entry list must follow the selected order. The core must keep source-list order on an equal entry comparison.

The core must keep the first `maxPerGroup` entries of each merged group, order the groups by their first retained entry's score under [Score Order](algorithms.md#score-order), and break a tie by that entry's `idRank`. `idRank` gives the document ID's place in code point order across every input list, independently of the sort values. An absent score counts as 0 for group ordering alone. An empty group has score 0 and an empty document ID for this comparison, and equal group comparisons keep the order in which their keys first appeared in the inputs. The core must then keep the first `limit` groups, or every group where `limit` is none. A limit of 0 returns no groups; `maxPerGroup` of 0 retains no entries. [Distributed Grouping](distribution/query-routing.md#distributed-grouping) defines the scores that the implementation must preserve before this call.

`measureFieldMerge` and `writeFieldMerge` merge the field indexes, the stored values, and the pattern indexes of several segments, as `measureMerge` and `writeMerge` merge their keyword regions. The core must remap each numeric, size, and geo entry through `mapping` and sort the result again, remap and unite the boolean bitsets, unite the enum values while it remaps their postings, and remap the ordinals of each pattern run, keeping each list ascending. An ordinal that `mapping` drops leaves every target region.

---

## Deterministic Functions

```text
applyMath(function, first: List<float64>, second: List<float64>, results: List<float64>) -> nothing

function: ln, sin, cos, tan, asin, atan, or atan2
```

`applyMath` must write into each place of `results` the value of `function` at the same place of `first`, computed as [Deterministic Functions](algorithms.md#deterministic-functions) defines. For `atan2`, it must take the element of `first` as `y` and the element of `second` at the same place as `x`, and for every other function it must ignore `second`. The core must refuse a `first` whose length differs from that of `results`, and an `atan2` call whose `second` differs in length from `results`. The operation counts no work, and an implementation in another language can call it to compare its port of these functions with the core on inputs beyond the test vectors.
