"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypeAlias

from pydantic import Field

from narsil_client._model import OPEN_ENUM, ApiModel


class AllocationConstraints(ApiModel):
    """The rules the allocator respects when it places partitions. The controller stores these with
    each index's metadata, so every node allocating that index applies the same rules.
    """

    zone_awareness: bool = Field(alias="zoneAwareness")
    """Setting this spreads an index's replicas across zones, so losing one zone never costs every
    copy.
    """
    zone_attribute: str = Field(alias="zoneAttribute")
    """This names the key in a node's `metadata` that carries its zone."""
    max_shards_per_node: int | float | None = Field(alias="maxShardsPerNode")
    """One node may hold this many partitions of an index, and `null` lifts the ceiling."""


AnyDocument: TypeAlias = dict[str, Any]
"""A document as the engine stores it: any set of fields, with an optional `id`. The engine takes the
`id` field as the document id when you insert without passing one. Every other field must match the
type its schema declares.
"""


class ComparisonFilter(ApiModel):
    """Compares one field against a value. Setting several keys narrows the match, because a
    document has to satisfy all of them.
    """

    eq: bool | str | int | float | None = None
    """This matches a field equal to the value, or a list field where one element equals it."""
    ne: bool | str | int | float | None = None
    """This matches a document that holds the field with a value other than this one, or a list
    field where every element differs from it, which an empty list does.
    """
    gt: int | float | None = None
    """This matches a field greater than the number."""
    lt: int | float | None = None
    """This matches a field less than the number."""
    gte: int | float | None = None
    """This matches a field greater than or equal to the number."""
    lte: int | float | None = None
    """This matches a field less than or equal to the number."""
    between: tuple[int | float, int | float] | None = None
    """This matches a field inside the inclusive range, given as `[low, high]`."""


class ArrayFilter(ApiModel):
    """Tests the contents of a list field, which is a `number[]`, `boolean[]`, `enum[]`,
    `verbatim[]`, or `string[]` field. The engine throws `SEARCH_INVALID_FILTER` for these tests
    on any other field, for a value whose type differs from the type of the list's elements, and
    for `containsAll` or `matchesAny` on a `string[]` field whose type leaves out `pattern`.
    """

    contains_all: list[bool | str | int | float] | None = Field(default=None, alias="containsAll")
    """This matches a list holding every one of the values, at most 65,536 of them, so an empty set
    of values matches every list.
    """
    matches_any: list[bool | str | int | float] | None = Field(default=None, alias="matchesAny")
    """This matches a list holding at least one of the values, at most 65,536 of them."""
    size: ComparisonFilter | None = None
    """This compares the number of elements in the list."""


class BackupSummary(ApiModel):
    """What a cluster records about one backup."""

    name: str
    """The name the backup was taken under."""
    index_name: str = Field(alias="indexName")
    """The index the backup holds."""
    started_at: int | float = Field(alias="startedAt")
    """The backup started at this many milliseconds since the epoch, and it holds every write
    acknowledged before then.
    """
    completed_at: int | float = Field(alias="completedAt")
    """The controller wrote the backup's manifest at this many milliseconds since the epoch."""
    partition_count: int | float = Field(alias="partitionCount")
    """The index had this many partitions, and a restore creates the same number."""
    replication_factor: int | float = Field(alias="replicationFactor")
    """The index kept this many replicas of each partition, and a restore asks for the same number.
    """
    files: int | float
    """The backup lists this many stored files, counting each partition's manifest and the index
    configuration.
    """
    bytes: int | float
    """The files the backup lists hold this many bytes in total, including files that other backups
    share.
    """


class DamagedBackupError(ApiModel):
    """Why the manifest can't be read, with the code `BACKUP_DAMAGED`."""

    code: str
    message: str


class DamagedBackup(ApiModel):
    """A backup whose manifest the cluster can't read, which a listing shows in place of its
    summary.
    """

    name: str
    """The name that the manifest is stored under."""
    error: DamagedBackupError
    """Why the manifest can't be read, with the code `BACKUP_DAMAGED`."""


BackupListing: TypeAlias = BackupSummary | DamagedBackup
"""One entry of ClusterNamespace.listBackups : a summary, or a DamagedBackup where the manifest can't
be read.
"""


class BackupListResponse(ApiModel):
    """The body of `GET /backups`."""

    backups: list[BackupListing]
    """One entry per backup in name order: its summary, or its name and a `BACKUP_DAMAGED` error
    where its manifest can't be read.
    """


class BatchBodyUpdatesItem(ApiModel):
    """The shape of one item of the `updates` field of `BatchBody`."""

    doc_id: str = Field(alias="docId")
    """The update replaces the document with this id."""
    document: AnyDocument
    """The update writes this document."""


class InsertOptions(ApiModel):
    """Per-write options for DocumentWriteOperations.insert and DocumentWriteOperations.insertBatch
    .
    """

    skip_clone: bool | None = Field(default=None, alias="skipClone")
    """Setting this stores the document object you passed instead of a copy, which saves a clone on
    a large load. Changing that object afterwards changes the stored document with it, so pass
    this only for a document you discard.
    """
    wait: bool | None = None
    """Setting this makes the write return only once every worker copy holding the index has
    applied it, so the next query sees it whichever copy answers. Leave it off for a load, and
    call DocumentWriteOperations.waitForWrites once at the end.
    """


class BatchBody(ApiModel):
    """The body of `POST /indexes/{name}/documents/_batch`."""

    action: Annotated[Literal["insert", "update", "delete"], OPEN_ENUM] | None = None
    """The server performs this action, and `insert` where you leave it out."""
    documents: list[AnyDocument] | None = None
    """The `insert` action writes these documents."""
    updates: list[BatchBodyUpdatesItem] | None = None
    """The `update` action replaces the document under each of these ids."""
    doc_ids: list[str] | None = Field(default=None, alias="docIds")
    """The `delete` action removes the documents with these ids."""
    options: InsertOptions | None = None
    """These settings apply to the whole batch."""


class ErrorDetail(ApiModel):
    """The code, the message, and the details of one failure, as the server writes it to JSON."""

    code: str
    """This code comes from either ServerErrorCodes or ErrorCodes ."""
    message: str
    """This describes the failure, for a log or a person."""
    details: dict[str, Any] | None = None
    """These values are behind the failure, such as the field or limit involved."""


class BatchFailure(ApiModel):
    """One document that a batch refused."""

    doc_id: str = Field(alias="docId")
    """The batch refused the document with this id."""
    error: ErrorDetail
    """This says why the batch refused the document."""


class BatchResponse(ApiModel):
    """The body of `POST /indexes/{name}/documents/_batch`. One bad document never abandons the
    rest, so read both lists.
    """

    succeeded: list[str]
    """The server wrote the documents under these ids."""
    failed: list[BatchFailure]
    """The server refused each of these documents."""


class BM25FieldParams(ApiModel):
    """The BM25 parameters of one text field, which override the same parameters at the level that
    names the field.
    """

    k1: int | float | None = None
    """This saturates term frequency in this field. It takes a number from 0 to 1,000."""
    b: int | float | None = None
    """This normalises by the length of this field. It takes a number from 0 to 1."""


class BM25Params(ApiModel):
    """BM25 tuning for an index or for one search. Both parameters default to the values the
    literature settles on, so change them only once you have measured relevance on your own
    corpus. For each field, the engine takes the first value that is set among the search's
    value for the field, the search's value, the index's value for the field, the index's value,
    and the default.
    """

    k1: int | float | None = None
    """This saturates term frequency, so a higher value lets a repeated term keep raising a score.
    It defaults to 1.2, and any value that is not a number from 0 to 1,000 fails with
    `CONFIG_INVALID`.
    """
    b: int | float | None = None
    """This normalises by field length, from 0 for none to 1 for full. It defaults to 0.75, and any
    value that is not a number from 0 to 1 fails with `CONFIG_INVALID`.
    """
    fields: dict[str, BM25FieldParams] | None = None
    """These parameters apply to the text fields that this map holds. A name that is not a text
    field that the schema declares fails with `CONFIG_INVALID` on an index and with
    `SEARCH_INVALID_FIELD` on a search.
    """


class CapabilitiesResponse(ApiModel):
    """What a server announces at `/capabilities`, which is how a client finds out whether an
    optional route or mode is available before it sends a request. A server that answers 404
    here predates the endpoint, so treat every optional capability as absent.
    """

    capabilities: list[str]
    """Each name marks one capability this server serves."""


class ChangeAnalysisBody(ApiModel):
    """The body of `POST /indexes/{name}/_change-analysis`, where a key that you leave out keeps
    its current value.
    """

    language: str | None = None
    """This is the name of a language registered on the server."""
    tokenizer: str | None = None
    """This is a name registered on the server, or `null` for the language default."""
    stop_words: str | list[str] | None = Field(default=None, alias="stopWords")
    """This is a name registered on the server, a list of words, or `null` for the language
    default.
    """


class PartitionAllocationReport(ApiModel):
    """One partition of an index, as `GET /indexes/{name}/cluster` reports it."""

    partition_id: int | float = Field(alias="partitionId")
    """This identifies the partition within its index."""
    state: str
    """The partition holds this allocation state."""
    primary: str | None
    """This node holds the primary copy, and the value is null while no node holds it."""
    primary_term: int | float = Field(alias="primaryTerm")
    """The primary holds this term."""
    commit_point: int | float = Field(alias="commitPoint")
    """The primary has acknowledged writes up to this sequence number."""
    replicas: list[str]
    """These nodes hold replica copies."""
    in_sync_set: list[str] = Field(alias="inSyncSet")
    """These nodes hold replica copies that are up to date."""
    last_holders: list[str] = Field(alias="lastHolders")
    """These nodes held a copy before the partition lost its primary."""
    unassigned_reason: str | None = Field(alias="unassignedReason")
    """This says why the partition has no node, and the value is null while it has one."""


class ClusterAllocationResponse(ApiModel):
    """The body of `GET /indexes/{name}/cluster`."""

    index_name: str = Field(alias="indexName")
    """The report covers the index with this name."""
    allocated: bool
    """This is true where the cluster has placed at least one partition of the index."""
    version: int | float | None
    """The allocation table holds this version, and the value is null where the index has no table.
    """
    partitions: list[PartitionAllocationReport]
    """One entry describes each partition, in partition order."""


ClusterHealthStatus: TypeAlias = Annotated[Literal["green", "yellow", "red"], OPEN_ENUM]
"""How well the cluster holds an index, or the whole cluster, from the best status to the worst.
`green` means every partition is `ACTIVE` with a primary and `replicationFactor` in-sync replicas.
`yellow` means every partition has a primary but some partition holds fewer in-sync replicas. `red`
means some partition has no primary, so the documents that it holds can be neither read nor written.
A primary or a replica counts only while its node stays registered with the coordinator, because a
copy on a node that has left serves nothing.
"""
