"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field

from narsil_client._model import OPEN_ENUM, ApiModel
from narsil_client.models._part_01 import AnyDocument, InsertOptions
from narsil_client.models._part_03 import FilterExpression
from narsil_client.models._part_04 import SchemaDefinition
from narsil_client.models._part_05 import SortField


class ImportError(ApiModel):
    """One record an import refused, naming the line it came from and why the server rejected it."""

    line: int | float | None = None
    """The failing record sat on this line of the body, counting from one."""
    doc_id: str | None = Field(default=None, alias="docId")
    """The engine rejected the document stored under this id."""
    code: str
    """This says which failure it is."""
    message: str
    """This describes the failure, for a log or a person."""
    details: dict[str, Any] | None = None
    """The server puts the facts that explain the failure here where it has any, such as the
    `reason` for a line that it refused to parse because parsing the line could fill the heap.
    """


class ImportResult(ApiModel):
    """What one import produced. `errors` is capped by the server's `maxImportErrors` limit while
    `failed` counts every refusal, so a run that trips the cap reports the true total and sets
    `errorsTruncated`.
    """

    indexed: int | float
    """The engine accepted this many documents."""
    failed: int | float
    """The server refused this many records in total."""
    errors: list[ImportError]
    """The first refusals, up to the server's reporting cap."""
    errors_truncated: bool = Field(alias="errorsTruncated")
    """Setting this says more records failed than `errors` lists."""


class IndexClearedResponse(ApiModel):
    """The body of `POST /indexes/{name}/_clear`."""

    name: str
    """The server removed every document from the index with this name."""
    cleared: bool
    """This is always true."""


class IndexCreatedResponse(ApiModel):
    """The body of `POST /indexes`, which the server sends once the index exists."""

    name: str
    """The server created the index under this name."""


class IndexDroppedResponse(ApiModel):
    """The body of `DELETE /indexes/{name}`."""

    name: str
    """The server dropped the index with this name."""
    dropped: bool
    """This is always true."""


class IndexInfo(ApiModel):
    """A summary of one index, as Narsil.listIndexes reports it."""

    name: str
    """The index was created under this name."""
    document_count: int | float = Field(alias="documentCount")
    """The index holds this many documents. A closed index reports its count as of the last
    checkpoint.
    """
    partition_count: int | float = Field(alias="partitionCount")
    """The index is spread across this many partitions."""
    language: str
    """The index analyses text with this language module."""
    analysis_stale: bool | None = Field(default=None, alias="analysisStale")
    """This turns true when the index's terms came from an older analysis than its language module
    produces now.
    """
    state: Annotated[Literal["open", "closed", "reopen-failed"], OPEN_ENUM]
    """This is `open` in memory, `closed` after release, and `reopen-failed` after five recovery
    failures.
    """
    reopen_count: int | float = Field(alias="reopenCount")
    """This counts successful loads since this engine started."""


class IndexListResponse(ApiModel):
    """The body of `GET /indexes`."""

    indexes: list[IndexInfo]
    """Each index appears here once, in creation order."""


class PartitionStatsResult(ApiModel):
    """What Narsil.getPartitionStats reports for one partition, which is where you look when an
    index grows unevenly.
    """

    partition_id: int | float = Field(alias="partitionId")
    """This identifies the partition within its index."""
    document_count: int | float = Field(alias="documentCount")
    """The partition holds this many documents."""
    estimated_memory_bytes: int | float = Field(alias="estimatedMemoryBytes")
    """Formula-based estimate of this partition's memory footprint. V8 has no per-object heap
    accounting API, so this number is derived from structural counters (document count, posting
    counts, field-index sizes) and does not include per-object overhead. Treat as an estimate,
    not a measurement.
    """


class IndexPartitionsResponse(ApiModel):
    """The body of `GET /indexes/{name}/partitions`."""

    partitions: list[PartitionStatsResult]
    """One entry describes each partition of the index."""


class IndexStateResponse(ApiModel):
    """The body of `POST /indexes/{name}/_open` and `POST /indexes/{name}/_close`."""

    name: str
    """The request changed the index with this name."""
    state: Annotated[Literal["open", "closed"], OPEN_ENUM]
    """The index holds this state now."""


class IndexStats(ApiModel):
    """What Narsil.getStats returns about one index."""

    document_count: int | float = Field(alias="documentCount")
    """The index holds this many documents. A closed index reports its count as of the last
    checkpoint.
    """
    partition_count: int | float = Field(alias="partitionCount")
    """The index is spread across this many partitions."""
    estimated_memory_bytes: int | float = Field(alias="estimatedMemoryBytes")
    """Formula-based estimate of the index's main-thread memory footprint, summed across every
    partition and vector index for this index. Computed from structural counters (document
    count, posting counts, field-index sizes), not measured. Per-object V8 overhead (hidden
    classes, map transitions, GC headers) is not captured here, so this number routinely
    undershoots the real heap by a meaningful factor. Use Narsil.getMemoryStats when sizing host
    memory.
    """
    language: str
    """The index analyses text with this language module."""
    schema_: SchemaDefinition = Field(alias="schema")
    """The index was created with this field layout."""


class InsertBody(ApiModel):
    """The body of `POST /indexes/{name}/documents`."""

    document: AnyDocument
    """The server stores this document."""
    id: str | None = None
    """The server stores the document under this id, and takes the document's `id` field or a new
    id where you leave this out.
    """
    options: InsertOptions | None = None
    """These settings control how the write reaches the worker copies."""


class ListedDocument(ApiModel):
    """One stored document, as Narsil.listDocuments returns it."""

    id: str
    """The document is stored under this id."""
    document: AnyDocument
    """This holds the stored document, cut down to what the projection kept."""


class ListParamsDocumentObject(ApiModel):
    """The shape of one form of the `document` field of `ListParams`."""

    include: list[str] | None = None
    """Names the fields to keep, so every field left out of this list is dropped."""
    exclude: list[str] | None = None
    """Names the fields to drop, so every other field is kept."""


class ListParams(ApiModel):
    """Everything Narsil.listDocuments accepts. Narsil.listDocuments reads the stored documents
    without ranking them, which is how you page through a whole index. Leave `cursor` out to
    start at the first document, then pass back the cursor each result carries until it comes
    back null. A cursor belongs to the sort it was made under, so pass the same `sort` back with
    it. Changing `sort` invalidates the cursor, and the engine then throws
    `SEARCH_INVALID_CURSOR` rather than returning a page from the wrong order.
    """

    cursor: str | None = None
    """This cursor comes from a previous result, and continues where it stopped. The engine ties a
    cursor to the sort that produced it, and it throws `SEARCH_INVALID_CURSOR` for a cursor sent
    back under a different sort.
    """
    limit: int | float | None = None
    """The page carries this many documents, and 10 by default. The engine raises a value below one
    to one.
    """
    filters: FilterExpression | None = None
    """This narrows the listing to the documents the filter accepts."""
    sort: dict[str, Annotated[Literal["asc", "desc"], OPEN_ENUM]] | list[SortField] | None = None
    """This orders the listing by field value rather than by document id, and the engine applies
    the fields in the order they are listed. Pass an object keyed by field, or a list of fields
    in the order they apply. It breaks a tie on document id, and it sorts by at most eight
    fields. The engine uses document-id order when you leave this out. The engine reads every
    document the listing covers to build a sorted page, so a sorted listing costs more than the
    default order on a large index.
    """
    document: bool | ListParamsDocumentObject | None = None
    """This chooses how much of each stored document comes back, and the whole document by default.
    """


class ListResult(ApiModel):
    """What Narsil.listDocuments returns: one page of stored documents and the cursor that reaches
    the next one.
    """

    documents: list[ListedDocument]
    """These documents make up the page, in ascending document-id order."""
    cursor: str | None
    """This opaque cursor reaches the next page, and is null once the listing is finished."""
    total: int | float
    """The listing covers this many documents in total, and any filter narrows that count."""
    elapsed: int | float
    """The engine spent this many milliseconds building the page."""


class LivenessResponse(ApiModel):
    """The body of `GET /livez`."""

    status: Annotated[Literal["ok"], OPEN_ENUM]
    """This is always `ok`, because the process answered."""


class MemoryStatsResponseWorkersItem(ApiModel):
    """The shape of one item of the `workers` field of `MemoryStatsResponse`."""

    worker_id: int | float = Field(alias="workerId")
    """This identifies the worker within the pool."""
    heap_used: int | float = Field(alias="heapUsed")
    """That worker is using this much heap."""
    heap_total: int | float = Field(alias="heapTotal")
    """V8 has reserved this much heap in that worker."""
    heap_limit: int | float | None = Field(alias="heapLimit")
    """That worker's heap may grow to this many bytes, or `null` where its runtime cannot report
    it.
    """
    external: int | float
    """That worker holds this much outside its heap."""


class ProcessMemoryReport(ApiModel):
    """Snapshot of V8 heap usage as reported by `process.memoryUsage()`, with the limit the heap
    may grow to. All values are bytes. `null` in environments that do not expose
    `process.memoryUsage`, such as browsers.
    """

    heap_used: int | float = Field(alias="heapUsed")
    """The process is using this much heap."""
    heap_total: int | float = Field(alias="heapTotal")
    """V8 has reserved this much heap."""
    heap_limit: int | float | None = Field(alias="heapLimit")
    """The heap may grow to this many bytes before the runtime ends the process for running out of
    memory. Node sets it from `--max-old-space-size`, from `--max-old-space-size-percentage`, or
    from the memory the host or the container reports. `null` where the runtime cannot report
    it.
    """
    external: int | float
    """The process holds this much outside the heap, such as buffers."""
    rss: int | float
    """The process occupies this much physical memory in total."""


class WorkerCopyReport(ApiModel):
    """Whether one index holds worker copies at the moment Narsil.getMemoryStats reads it, and how
    many times it has loaded them again after giving them up while idle.
    """

    index_name: str = Field(alias="indexName")
    """This names the index."""
    scaled_out: bool = Field(alias="scaledOut")
    """This is true while every worker holds a copy of the index."""
    reload_count: int | float = Field(alias="reloadCount")
    """The index has loaded its copies again this many times after an idle spell dropped them."""
