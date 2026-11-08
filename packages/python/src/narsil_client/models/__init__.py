"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypeAlias

from pydantic import Field
from typing_extensions import TypeAliasType

from narsil_client._model import OPEN_ENUM, ApiModel
from narsil_client._score import ScoredHitModel


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


class IndexHealth(ApiModel):
    """How well the cluster holds one index."""

    index_name: str = Field(alias="indexName")
    """The index that the cluster holds."""
    status: ClusterHealthStatus
    """The status of the index, which its weakest partition sets."""
    partition_count: int | float = Field(alias="partitionCount")
    """The number of partitions that the index has."""
    replication_factor: int | float = Field(alias="replicationFactor")
    """The number of in-sync replicas besides the primary that each partition should keep."""
    partitions_without_primary: int | float = Field(alias="partitionsWithoutPrimary")
    """The number of partitions that have no primary."""
    under_replicated_partitions: int | float = Field(alias="underReplicatedPartitions")
    """The number of partitions that have a primary but are not `ACTIVE` or hold fewer in-sync
    replicas than the factor.
    """


class ClusterHealth(ApiModel):
    """How well the cluster holds every index that it serves."""

    status: ClusterHealthStatus
    """The worst status of any index, or `green` for a cluster that holds no index."""
    indexes: list[IndexHealth]
    """One entry per index, sorted by name."""


class NodeMemoryReport(ApiModel):
    """How much memory one node uses against its limits, which the node publishes with every
    heartbeat so that the cluster stops taking writes before the node runs out of memory.
    """

    process_bytes: int | float = Field(alias="processBytes")
    """The whole process holds this many bytes of resident memory, including vectors and segments
    kept outside the heap.
    """
    process_limit_bytes: int | float = Field(alias="processLimitBytes")
    """The process may hold this many bytes. Where a container sets a memory limit, this figure is
    that limit. Without one, a node on Linux reports its own resident memory plus the memory
    that the host reports as available, up to the host's total memory, so the figure falls
    whenever other processes on the host take memory. A node on any other system reports the
    host's total memory.
    """
    heap_bytes: int | float = Field(alias="heapBytes")
    """The main thread's old generation uses this many bytes. The old generation is the V8 heap
    without the young generation, which holds new objects until the collector empties it.
    """
    heap_limit_bytes: int | float = Field(alias="heapLimitBytes")
    """The main thread's old generation may grow to this many bytes. This is the
    `--max-old-space-size` figure where the process sets it, and otherwise V8's heap limit less
    the young generation's share.
    """
    full: bool
    """This is true while the node refuses writes, which starts once either figure passes the block
    fraction of its limit and ends once both fall below the resume fraction. Every index with a
    copy on the node refuses inserts and updates with `CLUSTER_WRITE_BLOCKED` while it holds.
    """


NodeRole: TypeAlias = Annotated[Literal["data", "coordinator", "controller"], OPEN_ENUM]
"""What a node does in a cluster. A node may hold several roles at once. A `data` node holds partitions
and answers queries, a `coordinator` node routes requests without holding data, and a `controller`
node runs the allocation decisions for the whole cluster.
"""


class ClusterMemberReport(ApiModel):
    """One member of a cluster, as `GET /cluster` reports it."""

    node_id: str = Field(alias="nodeId")
    """This identifies the node across the cluster."""
    address: str
    """Peers reach the node at this address."""
    roles: list[NodeRole]
    """The node holds these roles in the cluster."""
    memory: NodeMemoryReport | None
    """The node uses this much memory, or null where its runtime cannot measure it."""


NodeReadiness: TypeAlias = Annotated[Literal["STARTING", "JOINING", "SERVING", "LEAVING"], OPEN_ENUM]
"""Where a node stands between starting and shutting down, which is what a readiness probe reads. A
node reports `STARTING` until it holds a registration. It reports `JOINING` while it bootstraps a
partition the controller gave it, and `SERVING` once it serves every one of them. It reports
`LEAVING` from the moment shutdown begins.
"""


class ClusterNodeReport(ApiModel):
    """The cluster node that a server fronts, as `/readyz` and `/cluster` report it."""

    readiness: NodeReadiness
    """This says whether the node can serve requests now."""
    is_controller: bool = Field(alias="isController")
    """This is true while the node holds the controller lease."""
    node_id: str = Field(alias="nodeId")
    """This identifies the node across the cluster."""
    roles: list[NodeRole]
    """The node holds these roles in the cluster."""
    status: str
    """This says where the node stands, from joining through to shut down."""


class ClusterTopologyResponse(ApiModel):
    """The body of `GET /cluster`."""

    node: ClusterNodeReport
    """This describes the node that answered."""
    controller_node_id: str | None = Field(alias="controllerNodeId")
    """This node holds the controller lease, and the value is null while no node holds it."""
    nodes: list[ClusterMemberReport]
    """One entry describes each registered node."""


class CreateBackupBody(ApiModel):
    """The body of `POST /indexes/{name}/backups`."""

    backup: str
    """The backup's name, from 1 to 128 letters, digits, `.`, `_`, and `-`, starting with a letter
    or a digit.
    """
    query_history: bool | None = Field(default=None, alias="queryHistory")
    """Set this to true to add every node's popular query suggestion history of the index to the
    backup. The history holds the scrambled text of what people searched for, and the backup
    keeps it after `retentionDays` ends.
    """


class CreateIndexEmbedding(ApiModel):
    """How a JSON `createIndex` request connects an index to an embedding adapter. An adapter is a
    function and cannot cross JSON, so the request names one the server registered instead of
    carrying it.
    """

    adapter: str | None = None
    """This names an adapter the server registered under `embeddingAdapters`."""
    fields: dict[str, str | list[str]]
    """This maps each vector field to the text field, or fields, the server embeds into it."""


class WriteOptions(ApiModel):
    """Per-write options every write accepts. A write returns once the main copy holds it, and it
    reaches the worker copies afterwards, so a query that a copy answers may come back without a
    write that returned before it.
    """

    wait: bool | None = None
    """Setting this makes the write return only once every worker copy holding the index has
    applied it, so the next query sees it whichever copy answers. Leave it off for a load, and
    call DocumentWriteOperations.waitForWrites once at the end.
    """


class DocumentBody(ApiModel):
    """The body of `PUT` and of `PATCH /indexes/{name}/documents/{id}`."""

    document: AnyDocument
    """The server writes this document under the id in the path."""
    options: WriteOptions | None = None
    """These settings control how the write reaches the worker copies."""


class DocumentCountResponse(ApiModel):
    """The body of `GET /indexes/{name}/count`."""

    count: int | float
    """The index holds this many documents."""


class DocumentExistsResponse(ApiModel):
    """The body of `GET /indexes/{name}/documents/{id}/_exists`."""

    exists: bool
    """This is true where the index holds a document with the id."""


class DocumentIdResponse(ApiModel):
    """The body of `POST /indexes/{name}/documents` and of `PATCH /indexes/{name}/documents/{id}`."""

    id: str
    """The server wrote the document under this id."""


class DocumentPutResponse(ApiModel):
    """The body of `PUT /indexes/{name}/documents/{id}`."""

    id: str
    """The server wrote the document under this id."""
    created: bool
    """This is true where the id was new, and false where the document replaced an existing one."""


class DocumentRemovedResponse(ApiModel):
    """The body of `DELETE /indexes/{name}/documents/{id}`."""

    id: str
    """The server removed the document with this id."""
    removed: bool
    """This is always true."""


class DocumentResponse(ApiModel):
    """The body of `GET /indexes/{name}/documents/{id}`."""

    document: AnyDocument
    """This is the stored document."""


class ErrorEnvelope(ApiModel):
    """The body every failed response carries, which is what an HTTP client parses on a non-2xx
    status.
    """

    error: ErrorDetail
    """This describes the failure."""


class FacetConfigValueRangesItem(ApiModel):
    """The shape of one item of the `ranges` field of `FacetConfigValue`."""

    from_: int | float = Field(alias="from")
    """The range starts at this value."""
    to: int | float
    """The range ends at this value."""


class FacetConfigValue(ApiModel):
    """The shape of each value of `FacetConfig`."""

    limit: int | float | None = None
    """The engine returns this many values for the field, in the order of `sort`. An engine returns
    every value where you leave this out, while a cluster returns 10, or every range of a field
    that sets `ranges`.
    """
    sort: Annotated[Literal["asc", "desc"], OPEN_ENUM] | None = None
    """The engine orders the returned values by their count, putting the highest first under
    `'desc'`, which is the default, and the lowest first under `'asc'`. Under `'asc'`, each
    cluster node sends the count of up to 10,000 values of the field, so the lowest counts are
    exact wherever no node holds more values than that.
    """
    ranges: list[FacetConfigValueRangesItem] | None = None
    """The engine counts a numeric field's matches into these ranges, with one count for each
    range. A cluster search counts up to 1,000 ranges on a field and throws `CONFIG_INVALID` for
    more.
    """


FacetConfig: TypeAlias = dict[str, FacetConfigValue]
"""Fields a query counts values for, keyed by field name."""


class FacetResult(ApiModel):
    """Counts for one faceted field."""

    values: dict[str, int | float]
    """This many documents match per value, keyed by value."""
    count: int | float
    """This is the number of entries in `values`, which is at most the facet's `limit`."""
    error_bound: int | float = Field(alias="errorBound")
    """Every count in `values` is at most this far below its true count. A value that the engine
    leaves out of `values` because of `limit` has a true count of at most this figure too. Where
    the engine counts a field on one thread, it counts every value exactly, so this figure is
    the largest count that it leaves out. Where it splits the count across worker copies or
    cluster nodes, each of them returns only its own top values, so the merged count of a value
    that is common overall but rare on one of them can lack the matches on that one. A bound of
    0 means that `values` holds every matching value, each with its exact count.
    """


class GeoPolygonFilterPolygonPointsItem(ApiModel):
    """The shape of one item of the `points` field of `GeoPolygonFilterPolygon`."""

    lat: int | float
    """The corner has this latitude, in degrees."""
    lon: int | float
    """The corner has this longitude, in degrees."""


class GeoPolygonFilterPolygon(ApiModel):
    """The engine tests the field against this polygon."""

    points: list[GeoPolygonFilterPolygonPointsItem]
    """The engine closes the ring through these corners in the order that you list them, so you can
    leave the first point off the end. It throws `SEARCH_INVALID_FILTER` for a ring of fewer
    than three corners, which encloses no area, and for a corner whose latitude is outside -90
    to 90 or whose longitude is outside -180 to 180. It also throws that error for a ring of
    more than 65,536 corners. List the corners counter-clockwise around the area, as in an
    exterior ring of GeoJSON. Where the corners span 180 degrees of longitude or more, the
    engine matches the area on the left of that path, so a ring listed that way can cross the
    antimeridian or span more than half the globe.
    """
    inside: bool | None = None
    """The engine matches the points inside the polygon while this is true, which is the default,
    and the points outside it while this is false.
    """


class GeoPolygonFilter(ApiModel):
    """Matches a `geopoint` field against a polygon drawn on the earth."""

    polygon: GeoPolygonFilterPolygon
    """The engine tests the field against this polygon."""


class GeoRadiusFilterRadius(ApiModel):
    """The engine tests the field against this circle."""

    lat: int | float
    """The centre has this latitude, in degrees from -90 to 90. For any other value, the engine
    throws `SEARCH_INVALID_FILTER`.
    """
    lon: int | float
    """The centre has this longitude, in degrees from -180 to 180. For any other value, the engine
    throws `SEARCH_INVALID_FILTER`.
    """
    distance: int | float
    """The circle has this radius, measured in `unit`."""
    unit: Annotated[Literal["km", "mi", "m"], OPEN_ENUM]
    """The engine measures `distance` in kilometres under `'km'`, in miles under `'mi'`, and in
    metres under `'m'`. For any other unit, it throws `SEARCH_INVALID_FILTER`.
    """
    inside: bool | None = None
    """The engine matches the points inside the circle while this is true, which is the default,
    and the points outside it while this is false.
    """
    high_precision: bool | None = Field(default=None, alias="highPrecision")
    """The engine measures each distance with the Haversine formula on a sphere by default, and
    with Vincenty's formula on the WGS-84 ellipsoid while this is true. Vincenty's formula
    iterates, so the engine takes longer to compute each distance. The two formulas differ by
    less than 0.3% under about 100 km, while across a continent they can differ by up to 0.5%.
    """


class GeoRadiusFilter(ApiModel):
    """Matches a `geopoint` field against a circle drawn on the earth."""

    radius: GeoRadiusFilterRadius
    """The engine tests the field against this circle."""


class PresenceFilter(ApiModel):
    """Tests whether a field carries a value at all, without looking at what it holds."""

    exists: bool | None = None
    """This matches a document where the field holds a value other than null."""
    not_exists: bool | None = Field(default=None, alias="notExists")
    """This matches a document where the field is absent or null."""
    is_empty: bool | None = Field(default=None, alias="isEmpty")
    """This matches a document where the field is absent, null, an empty string, or an empty list.
    """
    is_not_empty: bool | None = Field(default=None, alias="isNotEmpty")
    """This matches a document where the field holds a value other than an empty string or an empty
    list.
    """


class StringFilter(ApiModel):
    """The engine tests a text field against this filter for equality, for a text range, or with
    the set, prefix, and pattern tests. On a `string[]`, `verbatim[]`, or `enum[]` field, the
    engine tests each element of the list on its own. A document passes `eq`, `in`,
    `startsWith`, `endsWith`, `contains`, `wildcard`, or `regex` when one element passes the
    test. However, a document passes `ne` or `nin` only when every element differs from the
    values. The engine applies the range tests `gt`, `gte`, `lt`, `lte`, and `between` to a
    single `string` or `verbatim` field whose type includes `sortable`. It throws
    `SEARCH_INVALID_FILTER` for a text range on any other field. It orders the values as a sort
    on the field does, so it compares their case folds first and compares their raw code points
    only where the folds are equal. A pattern field is a `verbatim` or `verbatim[]` field, or a
    `string` or `string[]` field whose type includes `pattern`. On a pattern field, the engine
    answers `eq`, `ne`, `in`, `nin`, `startsWith`, `endsWith`, `contains`, `wildcard`, and
    `regex` from the field's pattern index, and `caseFold` applies to each of those tests. The
    engine compares the code points of each value as they are stored, with no Unicode
    normalisation. On an `enum` or `enum[]` field, the engine answers `eq`, `ne`, `in`, `nin`,
    `startsWith`, and `endsWith` from the field's index of values. A `string` or `string[]`
    field whose type leaves out `pattern` keeps no index of whole values, so the engine throws
    `SEARCH_INVALID_FILTER` for those six tests, and for `matchesAny` and `containsAll`, on such
    a field. The engine also throws `SEARCH_INVALID_FILTER` in these cases: - The filter sets
    `contains`, `wildcard`, `regex`, or `caseFold` on a field that is not a pattern field. - The
    text or the pattern of a test on a pattern field holds more than 1,024 code points. - A
    literal test under `caseFold` has a text whose case fold holds more than 2,048 code points.
    - A `wildcard` or `regex` pattern breaks its syntax or one of its limits.
    """

    eq: bool | str | int | float | None = None
    """This matches a field equal to the value, or a list field where one element equals it."""
    ne: bool | str | int | float | None = None
    """This matches a document that holds the field with a value other than this one, or a list
    field where every element differs from it, which an empty list does.
    """
    gt: str | None = None
    """This matches a value that comes after the text in sort order."""
    lt: str | None = None
    """This matches a value that comes before the text in sort order."""
    gte: str | None = None
    """This matches a value equal to the text or after it in sort order."""
    lte: str | None = None
    """This matches a value equal to the text or before it in sort order."""
    between: tuple[str, str] | None = None
    """This matches a value inside the inclusive range in sort order, given as `[low, high]`."""
    in_: list[str] | None = Field(default=None, alias="in")
    """This matches a field equal to any value in the list, which holds at most 65,536 values."""
    nin: list[str] | None = None
    """This matches a field that differs from every value in the list, which holds at most 65,536
    values.
    """
    starts_with: str | None = Field(default=None, alias="startsWith")
    """This matches a field starting with the text."""
    ends_with: str | None = Field(default=None, alias="endsWith")
    """This matches a field ending with the text."""
    contains: str | None = None
    """This matches a pattern field whose value holds the text anywhere in it."""
    wildcard: str | None = None
    """This matches a pattern field when the whole value matches the wildcard pattern. For example,
    `INV-*-2024` matches `INV-0042-2024`. In the pattern, `*` matches any sequence of code
    points, including an empty one, and `?` matches exactly one code point. Write `\\` before a
    code point to match that code point itself, so `\\*` matches an asterisk. The engine throws
    `SEARCH_INVALID_FILTER` for a pattern that ends in a `\\` with no code point after it. It
    throws the same error for a pattern with more than 2,048 positions. Each `*`, each `?`, and
    each other code point counts as one position, except that under `caseFold` a code point
    counts once for each code point of its case fold.
    """
    regex: str | None = None
    """This matches a pattern field when some part of the value matches the regular expression. `^`
    and `$` match only at the start and at the end of the whole value. The engine accepts
    literal code points, `.`, `\\d`, `\\w`, and `\\s`, sets such as `[a-z]` and `[^0-9]`,
    groups, and `|`. It also accepts the repeats `*`, `+`, `?`, `{n}`, `{n,}`, and `{n,m}`, the
    anchors `^` and `$`, the word edge `\\b`, and number ranges such as `<1-65535>`. A number
    range matches the digits of any whole number from its low end to its high end. Write `\\`
    before an ASCII punctuation mark to match the mark itself. The `.` matches any code point,
    including a line break. The matcher never backtracks, so it checks a value in at most as
    many steps as the value's code points multiplied by the pattern's positions. The engine
    throws `SEARCH_INVALID_FILTER` for any construct outside that syntax, such as a
    back-reference, a lookaround, a lazy repeat, or an inline flag. It throws the same error
    when the groups of a pattern nest more than 32 deep, when a count is above 2,048, and when a
    pattern holds more than 2,048 positions. When the operator of an HTTP server sets its
    `allowRegex` option to false, the server refuses every `regex` test.
    """
    case_fold: bool | None = Field(default=None, alias="caseFold")
    """When this is true, the engine compares the case fold of each value of a pattern field with
    the case fold of the text, so a test for `error` matches `ERROR`. It applies to `eq`, `ne`,
    `in`, `nin`, `startsWith`, `endsWith`, `contains`, `wildcard`, and `regex`. Under
    `caseFold`, a set that does not open with `^` can also match a sequence of code points. When
    a member that the set holds on its own folds to several code points, the set matches that
    whole fold, so `[ß]` matches `ss`.
    """
    tolerance: Annotated[Literal["auto"], OPEN_ENUM] | Literal[0, 2, 1] | None = None
    """This lets the `eq` test of a pattern field match a value within this many edits of the text,
    so a test for `INV-2O24` with a tolerance of 1 matches `INV-2024`. An edit inserts, deletes,
    or replaces one code point, so a swap of two neighbouring code points counts as two edits.
    With `caseFold`, the engine counts the edits between the case folds of the value and the
    text. The tolerance applies to `eq` alone, so the other tests of the field still compare
    exactly. The engine takes its candidates from the pattern index, so the case fold of the
    text has to hold enough distinct runs of three code points. For a tolerance of `k`, the
    engine needs `k × (2 + f) + 1` runs, where `f` is the number of code points in the longest
    case fold among the text's code points, which is 1 for most text. A tolerance of 1 on
    `INV-2O24` therefore needs 4 of its 6 runs, while a tolerance of 2 needs 7. Under `'auto'`,
    the engine uses 2 where the text holds enough runs for 2, otherwise 1 where it holds enough
    for 1, and otherwise 0. The engine throws `SEARCH_INVALID_FILTER` for a tolerance of 1 or 2
    on a text with too few runs, stating how many runs that tolerance needs. It throws the same
    error for any other tolerance, for a tolerance on a field that is not a pattern field, and
    for a tolerance in a filter without an `eq` test. Towards the pattern work cap, it counts
    one unit for each cell that it fills in the table of edit distances between the text and a
    value.
    """


FieldFilter: TypeAlias = (
    ComparisonFilter | StringFilter | ArrayFilter | PresenceFilter | GeoRadiusFilter | GeoPolygonFilter
)
"""The filter one field accepts. Which of these forms applies follows from the field's declared type.
"""


FieldType: TypeAlias = (
    Annotated[
        Literal[
            "string",
            "number",
            "boolean",
            "string:sortable",
            "string:pattern",
            "string:partial",
            "string:pattern:partial",
            "string:partial:pattern",
            "string:sortable:pattern",
            "string:sortable:partial",
            "string:sortable:pattern:partial",
            "string:sortable:partial:pattern",
            "string:partial:sortable",
            "string:pattern:sortable",
            "string:pattern:sortable:partial",
            "string:pattern:partial:sortable",
            "string:partial:sortable:pattern",
            "string:partial:pattern:sortable",
            "string[]",
            "string[]:sortable",
            "string[]:pattern",
            "string[]:partial",
            "string[]:pattern:partial",
            "string[]:partial:pattern",
            "string[]:sortable:pattern",
            "string[]:sortable:partial",
            "string[]:sortable:pattern:partial",
            "string[]:sortable:partial:pattern",
            "string[]:partial:sortable",
            "string[]:pattern:sortable",
            "string[]:pattern:sortable:partial",
            "string[]:pattern:partial:sortable",
            "string[]:partial:sortable:pattern",
            "string[]:partial:pattern:sortable",
            "verbatim",
            "verbatim:sortable",
            "verbatim[]",
            "verbatim[]:sortable",
            "enum",
            "geopoint",
            "number[]",
            "boolean[]",
            "enum[]",
        ],
        OPEN_ENUM,
    ]
    | str
)
"""The engine indexes each field of a schema according to the field's type, which is one of these. The
engine splits a `string` value into words, so it can find the document by any word in the value. It
can filter and sort by a `number`, `boolean`, or `enum` field. A `geopoint` value is a latitude and
longitude pair. A `vector[N]` value is an embedding with N dimensions. For each list form, the
engine indexes every element of the list. The engine stores and compares a `verbatim` value exactly
as written, as one piece of text. Because the engine keeps that value whole, it leaves the field out
of keyword search, although it can test the whole value in a filter. The engine keeps a pattern
index for every `verbatim` field, so it can also test such a field with `contains` and `caseFold`.
Add the TextFieldOption options to a `string` or `string[]` type, or `sortable` alone to a
`verbatim` or `verbatim[]` type, as in `string:sortable:pattern` or `verbatim[]:sortable`. The
engine stores the options in the order `sortable`, `pattern`, `partial`, whatever their order in the
type name. It raises `SCHEMA_INVALID_TYPE` for any other option, such as `number:sortable` or
`verbatim:pattern`, and for an option written twice. To sort by a text field, the engine keeps up to
the first 512 code points of every document's value in memory, against 8 bytes per document for a
number field. For that reason, the engine sorts by a text field only where the field's type includes
`sortable`, while it raises `SEARCH_INVALID_FIELD` for a sort on any other text field.
"""


class FilterExpression(ApiModel):
    """The filter that a query runs, built from per-field tests and the boolean operators that
    combine them. The engine answers every test from an index that it keeps for the field. It
    applies the filter before scoring, so a narrow filter makes a search cheaper. A filter nests
    at most 30 levels deep and holds at most 1,024 tests, counted across every field and nested
    expression. Past either limit, the engine throws `SEARCH_INVALID_FILTER`, while it throws
    `SEARCH_INVALID_FIELD` for a test on a field that the schema leaves out.
    """

    fields: dict[str, FieldFilter] | None = None
    """These per-field tests are keyed by field name, and a document has to satisfy every entry."""
    and_: list[FilterExpression] | None = Field(default=None, alias="and")
    """Every nested expression has to match."""
    or_: list[FilterExpression] | None = Field(default=None, alias="or")
    """At least one nested expression has to match."""
    not_: FilterExpression | None = Field(default=None, alias="not")
    """The nested expression has to fail."""


class HeldCheckpointReport(ApiModel):
    """An index whose checkpoints wait until a failed partition recovers, as Narsil.getMemoryStats
    reports it. The engine holds these checkpoints only for an index with a vector field,
    because each vector file mixes every partition's vectors, so a checkpoint would save the
    failed partition's vectors from memory. The write-ahead log of the index grows until the
    partition recovers or you restore the index from a snapshot.
    """

    index_name: str = Field(alias="indexName")
    """This is the index whose checkpoints wait."""
    partition_ids: list[int | float] = Field(alias="partitionIds")
    """These are the partitions of that index whose copy failed."""
    records_since_checkpoint: int | float = Field(alias="recordsSinceCheckpoint")
    """This many write-ahead log records of the index wait for a checkpoint."""
    document_bytes_since_checkpoint: int | float = Field(alias="documentBytesSinceCheckpoint")
    """The documents in those records hold about this many bytes."""


class HighlightConfig(ApiModel):
    """This configuration names the fields that receive highlighted snippets. It also sets how the
    engine marks those snippets up. The engine analyses the text of each returned field again to
    tag every word that it matched, so it tags the same words whatever the index's
    `trackPositions` setting is. It tags a word whose stem equals a query stem, and a word
    within the query's `tolerance` of a query stem. For a `prefix` query, it tags a word for the
    last query term only when that word completes the term or shares its stem.
    """

    fields: list[str]
    """The engine highlights these fields."""
    pre_tag: str | None = Field(default=None, alias="preTag")
    """The engine writes this before each match, and writes `<mark>` by default."""
    post_tag: str | None = Field(default=None, alias="postTag")
    """The engine writes this after each match, and writes `</mark>` by default."""
    max_snippet_length: int | float | None = Field(default=None, alias="maxSnippetLength")
    """The engine takes this many characters of the field around the densest run of matches, 200 by
    default. It returns a snippet longer than that number, because it then adds the opening and
    closing tags, and an ellipsis at each end where it cuts the field.
    """


class HighlightMatchPositionsItem(ApiModel):
    """The shape of one item of the `positions` field of `HighlightMatch`."""

    start: int | float
    """The match starts at this offset."""
    end: int | float
    """The match ends at this offset."""


class HighlightMatch(ApiModel):
    """A highlighted field, ready to render."""

    snippet: str
    """This is the field's text around the match, wrapped in the query's tags."""
    positions: list[HighlightMatchPositionsItem]
    """Each range gives the start and the end of one match in the original field, so you can render
    the highlight yourself. Where the snippet covers part of the field alone, the engine lists
    only the matches that the snippet displays. Every offset is a character count from the start
    of the original field, whatever the snippet contains.
    """


class PartitionConfig(ApiModel):
    """How many partitions an index opens with, and how many documents it accepts. An index opens
    with `maxPartitions` partitions and keeps that count until Narsil.rebalance changes it,
    because the engine adds no partition on its own. Set `watermark` to learn through the
    `partitionWatermark` event when an index fills its capacity.
    """

    max_docs_per_partition: int | float | None = Field(default=None, alias="maxDocsPerPartition")
    """The index accepts this many documents for each of its partitions, so its capacity is this
    number multiplied by its partition count. A write beyond that capacity raises
    `PARTITION_CAPACITY_EXCEEDED`. Leave the field unset to accept any number.
    """
    max_partitions: int | float | None = Field(default=None, alias="maxPartitions")
    """The index opens with this many partitions, 1 by default, and no rebalance may take it
    higher.
    """
    watermark: int | float | None = None
    """The engine emits `partitionWatermark` once the index fills this share of its capacity, above
    0 and at most 1.
    """


SchemaDefinition = TypeAliasType("SchemaDefinition", "dict[str, FieldType | SchemaDefinition]")
"""The field layout of an index, written as a plain object. Each key names a field and each value is
either its FieldType or a nested schema, which is how you describe an object inside a document.
Nesting goes four levels deep.
"""


class OneWaySynonymRule(ApiModel):
    """A one-way rule adds each word in `synonyms` to a search for `word`, while a search for one
    of those synonyms gains nothing from the rule.
    """

    word: str
    """A search for this word also matches the words in `synonyms`."""
    synonyms: list[str]
    """The rule holds from 1 to 99 synonyms, and each one must analyse to exactly one token."""


class TwoWaySynonymRule(ApiModel):
    """A two-way rule makes every word in `words` a synonym of every other word in the rule, so a
    search for any one of them also matches documents that hold the others.
    """

    words: list[str]
    """The rule holds from 2 to 100 words, and each word must analyse to exactly one token."""


SynonymRule: TypeAlias = TwoWaySynonymRule | OneWaySynonymRule
"""One rule of a synonym set, which IndexConfig.synonyms and SynonymOperations.updateSynonyms take as a
list. The engine analyses every word with the language, the tokeniser, and the stop words of the
index, so a rule that says `jackets` also matches `jacket` wherever the index stems the two alike. A
set can hold up to 100,000 rules, 500,000 words, and 4,194,304 bytes of words in UTF-8.
"""


class VectorIndexConfigHnswConfig(ApiModel):
    """These settings shape the graph: neighbours per node, build-time exploration, and the metric
    that ranks results.
    """

    m: int | float | None = None
    """The graph keeps this many neighbours per node."""
    ef_construction: int | float | None = Field(default=None, alias="efConstruction")
    """The engine explores this many candidates as it builds the graph."""
    metric: Annotated[Literal["cosine", "dotProduct", "euclidean"], OPEN_ENUM] | None = None
    """This metric ranks the results."""


class VectorIndexConfig(ApiModel):
    """Controls when a vector field moves from a brute-force scan to an HNSW graph, and how that
    graph is built. A small field answers faster from a brute-force scan, so the engine builds a
    graph only once the field holds enough vectors to earn one. Leave every field unset to
    accept the engine's own values.
    """

    threshold: int | float | None = None
    """The engine promotes the field to an HNSW graph once it holds this many vectors."""
    filter_threshold: int | float | None = Field(default=None, alias="filterThreshold")
    """A selectivity ratio between 0 and 1, defaulting to 0.03. A filtered search whose filter
    matches a smaller share of the graph's vectors scans just the matches, and one matching a
    larger share searches the graph. The engine clamps any value outside that range to it.
    """
    hnsw_config: VectorIndexConfigHnswConfig | None = Field(default=None, alias="hnswConfig")
    """These settings shape the graph: neighbours per node, build-time exploration, and the metric
    that ranks results.
    """
    quantization: Annotated[Literal["osq8", "osq4", "osq2", "osq1", "none"], OPEN_ENUM] | None = None
    """The engine codes the promoted vectors in this mode. When this is unset, it picks the mode by
    the field's dimension. Set `none` to rank by the vectors alone.
    """
    storage: Annotated[Literal["memory", "disk"], OPEN_ENUM] | None = None
    """The engine keeps the field's full-precision vectors here. When this is unset, it picks
    `disk` under filesystem durability and `memory` on every other engine.
    """


class HttpIndexBody(ApiModel):
    """The settings of a new index as `POST /indexes` reads them, which is HttpIndexConfig with
    each field type spelled out.
    """

    bm25: BM25Params | None = None
    """These parameters tune BM25 for this index and for each of its text fields."""
    language: str | None = None
    """The server tokenises and stems text fields with the language module registered under this
    name.
    """
    default_scoring: Annotated[Literal["local", "dfs", "broadcast"], OPEN_ENUM] | None = Field(
        default=None, alias="defaultScoring"
    )
    """A query scores this way unless it asks for another mode."""
    tokenizer: str | None = None
    """This is the name of a tokeniser registered on the server, which then splits text in place of
    the language's own rules.
    """
    stop_words: str | list[str] | None = Field(default=None, alias="stopWords")
    """This name of a stop word set registered on the server, or this list, replaces the language's
    stop words.
    """
    track_positions: bool | None = Field(default=None, alias="trackPositions")
    """Setting this records term positions in each posting, which the `.nrsl` format carries for
    readers that match phrases. Highlighting works without it.
    """
    text_storage: Annotated[Literal["memory", "disk"], OPEN_ENUM] | None = Field(default=None, alias="textStorage")
    """Setting this to `disk` lets the index answer from segment files that the server reads by
    position, which needs filesystem durability. The default is `memory`.
    """
    surface_forms: bool | None = Field(default=None, alias="surfaceForms")
    """Setting this to false returns index stems from suggestions and prefix expansion, instead of
    the words users typed.
    """
    strict: bool | None = None
    """Setting this rejects a document carrying a field the schema does not declare."""
    embedding: CreateIndexEmbedding | None = None
    """This names a server-registered embedding adapter and the fields it embeds."""
    required: list[str] | None = None
    """The server rejects a document that omits any of these fields."""
    pattern_value_limit: int | float | None = Field(default=None, alias="patternValueLimit")
    """The server returns a `DOC_VALIDATION_FAILED` error for a document whose value in a
    `verbatim` field, or in a field whose type includes `pattern`, is longer than this many code
    points. Set a whole number from 1 to 65,536, or leave this unset for a limit of 8,192.
    """
    synonyms: list[SynonymRule] | None = None
    """A search for a word in one of these rules also matches its synonyms, and the server refuses
    a set beyond 100,000 rules, 500,000 words, or 4,194,304 bytes of words in UTF-8 with
    `CONFIG_INVALID`.
    """
    schema_: SchemaDefinition = Field(alias="schema")
    """This layout gives each value as either a field type or a nested schema."""
    partitions: PartitionConfig | None = None
    """These settings control how the index splits documents across partitions as it grows."""
    vector_promotion: VectorIndexConfig | None = Field(default=None, alias="vectorPromotion")
    """These settings control when vector fields move to an HNSW graph, and how that graph is
    built.
    """


class HttpCreateIndexBody(ApiModel):
    """The body of `POST /indexes`, which is CreateIndexRequest with the settings of HttpIndexBody."""

    name: str
    """The server creates the index under this name."""
    config: HttpIndexBody
    """This carries the schema and settings, in the subset JSON can express."""


class ScoreComponents(ApiModel):
    """The numbers BM25 combined into one hit's score, which is what you read when a ranking
    surprises you.
    """

    term_frequencies: dict[str, int | float] = Field(alias="termFrequencies")
    """Each query term appears in one field of this document this many times, under a key of
    `field:term`. A term that appears in two fields therefore has two entries here, while the
    keys of ScoreComponents.idf hold the bare term.
    """
    field_lengths: dict[str, int | float] = Field(alias="fieldLengths")
    """Each field the query searched holds this many tokens, keyed by field."""
    idf: dict[str, int | float]
    """Each query term carries this inverse document frequency, which is what makes a rare term
    count for more.
    """


class Hit(ScoredHitModel):
    """A search hit whose score uses the HTTP representation of HttpScore."""

    document: AnyDocument
    """This is the stored document."""
    id: str
    """The document is stored under this id."""
    score_components: ScoreComponents | None = Field(default=None, alias="scoreComponents")
    """These are the parts the score was built from, which arrive when the query asked for them."""
    highlights: dict[str, HighlightMatch] | None = None
    """These highlighted snippets are keyed by field, and arrive when the query asked for
    highlighting.
    """
    score: int | float | None = None
    """The client decodes this value to a numeric score, or leaves it absent when the search
    returns no score.
    """


class HttpGroupResult(ApiModel):
    """One group of hits as the server sends it, which is GroupResult with no reducer output,
    because the server refuses a query with a reducer.
    """

    values: dict[str, Any]
    """Each grouping field holds this value for the group, keyed by field."""
    hits: list[Hit]
    """These hits retain the scores of the group's ranking."""


class HttpQueryParamsPinnedItem(ApiModel):
    """The shape of one item of the `pinned` field of `HttpQueryParams`."""

    doc_id: str = Field(alias="docId")
    """The engine places the document with this id."""
    position: int | float
    """The document takes this place in the results, counting from zero."""


class HttpQueryParamsDocumentObject(ApiModel):
    """The shape of one form of the `document` field of `HttpQueryParams`."""

    include: list[str] | None = None
    """Names the fields to keep, so every field left out of this list is dropped."""
    exclude: list[str] | None = None
    """Names the fields to drop, so every other field is kept."""


class HttpQueryParamsGroup(ApiModel):
    """These settings collapse the hits into groups by field value."""

    fields: list[str]
    """The values of these fields define a group, and several fields group by their combination."""
    limit: int | float | None = None
    """The engine returns this many groups, best first, and every group where you leave this out."""
    max_per_group: int | float | None = Field(default=None, alias="maxPerGroup")
    """The engine returns this many hits from each group, best first, and one hit where you leave
    this out.
    """


class HybridConfig(ApiModel):
    """How a hybrid query merges its keyword ranking with its vector ranking. `rrf` combines the
    two by rank alone, which needs no tuning and handles scores that live on different scales.
    `linear` blends the scores directly, which gives you control once you know what each side's
    scores look like.
    """

    strategy: Annotated[Literal["rrf", "linear"], OPEN_ENUM] | None = None
    """The engine merges the rankings this way, and by rank fusion by default. It throws
    `CONFIG_INVALID` for any other value.
    """
    k: int | float | None = None
    """The engine uses this rank-fusion constant under `rrf` alone, where a larger value reduces
    the lead of the top ranks. Set a whole number of at least 1, or leave it out for 60. The
    engine throws `CONFIG_INVALID` for any other value.
    """
    alpha: int | float | None = None
    """The engine uses this weight of the vector score, from 0 to 1, under `linear` alone, and 0.5
    where you leave it out. It throws `CONFIG_INVALID` for a value outside that range.
    """
    depth: int | float | None = None
    """Set a depth to get the same fused order on every page of one query, and a cursor that
    resumes it. The engine then fetches this many results from the keyword search and from the
    vector search, fuses them, and pages through the top `depth` of the fused list. The last
    page stops at this depth, so it can hold fewer hits than the limit. Set a whole number from
    1 to 10,000. The engine throws `CONFIG_INVALID` for any other value, and
    `SEARCH_RESULT_WINDOW_EXCEEDED` for a page that starts at this depth or beyond. Where you
    leave the depth out, each search fetches only enough results to fill the page, so the fused
    order can change from one page to the next, and a cluster refuses a cursor with
    `SEARCH_INVALID_CURSOR`.
    """


class RerankConfig(ApiModel):
    """How a query reorders its top hits with a rerank adapter. The engine ranks the query as it
    would without this setting, passes the top `window` hits to the adapter, and orders them by
    the adapter's scores. The hits past the window follow in their first ranking, with their
    scores scaled below the lowest reranked score, so every page of one query comes from the
    same order.
    """

    adapter: str
    """The engine scores the hits with the rerank adapter registered under this key. It throws
    `RERANK_CONFIG_INVALID` for a key that it has not registered.
    """
    fields: list[str]
    """The engine sends the adapter the values of these text fields, in this order and joined with
    newlines, as the text of each hit. Each member of a list field takes a line of its own. The
    engine throws `RERANK_CONFIG_INVALID` for an empty list, for a field that the schema does
    not declare as text, and for a field that the list gives twice.
    """
    query: str | None = None
    """The adapter compares each hit with this text. Where you leave it out, the engine sends the
    query's `term`, or else its `vector.text`, and it throws `RERANK_CONFIG_INVALID` where the
    query carries neither.
    """
    window: int | float | None = None
    """The engine reranks this many of the top hits, from 1 to the engine's `maxRerankWindow`.
    Where you leave the window out, the engine reranks the smallest of 100 and
    `maxRerankWindow`, and no more than the `hybrid.depth` of a hybrid query that sets one. A
    hybrid query that sets `hybrid.depth` reranks its fused list at that depth, so the engine
    throws `RERANK_CONFIG_INVALID` when you set a window above that depth.
    """


class SortField(ApiModel):
    """One field of a sort, and the direction that field orders by."""

    field: str
    """The field the engine reads, which may name a nested field with dots."""
    direction: Annotated[Literal["asc", "desc"], OPEN_ENUM]
    """Ascending or descending order for this field."""
    mode: Annotated[Literal["min", "max", "avg", "median"], OPEN_ENUM] | None = None
    """Where a document's field holds a list, the engine sorts that document by one value from the
    list: the smallest under `'min'`, the largest under `'max'`, and the mean or the median of
    the list's numbers under `'avg'` or `'median'`. Where you leave this out, the engine uses
    `'min'` for an ascending sort and `'max'` for a descending one. It sorts by a field that
    holds a single value as that value stands, under every mode. It throws
    `SEARCH_INVALID_FIELD` for `'avg'` or `'median'` on a field that the schema declares as
    anything other than `number` or `number[]`.
    """


class VectorQueryConfig(ApiModel):
    """Vector-search inputs passed under `QueryParams.vector`. Supply either a raw `value` array or
    a `text` string for auto-embedding; passing both throws `EMBEDDING_CONFIG_INVALID`. Result
    count is governed by the outer query's `limit`, not by any field on this object.
    """

    field: str
    """Name of the schema field that holds the vector to compare against. Must reference a field
    declared as `vector[N]` in the index schema.
    """
    value: list[int | float] | None = None
    """Raw query vector, given as a number array or a `Float32Array`. Length must match the indexed
    field's dimension or the search rejects the request with `VECTOR_DIMENSION_MISMATCH`.
    """
    text: str | None = None
    """Text to embed at query time using the index or instance embedding adapter. Mutually
    exclusive with `value`; requires a configured adapter.
    """
    similarity: int | float | None = None
    """Score floor applied during ranking. Hits scoring below this value are dropped before `limit`
    is enforced, so the returned hit count can be smaller than `limit` even when more documents
    exist. The floor is interpreted in score space for every metric; for `euclidean`, distance
    is mapped to a similarity score of `1 / (1 + distance)` first. Defaults to no floor.
    """
    metric: Annotated[Literal["cosine", "dotProduct", "euclidean"], OPEN_ENUM] | None = None
    """Similarity metric used for ranking. Defaults to `cosine`. Choose `dotProduct` for raw
    inner-product scoring on already-normalised vectors and `euclidean` for distance-based
    ordering.
    """
    ef_search: int | float | None = Field(default=None, alias="efSearch")
    """The engine keeps this many candidates as it walks the HNSW graph, so a higher value can find
    more of the true neighbours, although each query takes longer. The engine applies it only
    once the field holds a graph. The engine fetches k hits, where k is one more than the number
    of hits up to the end of the page, so k is `limit` plus 1 on a first page. When a query
    leaves `efSearch` unset, the engine keeps the larger of 50 and k plus a margin, where the
    margin is 50 below 768 dimensions, 75 from 768 to 1,023 dimensions, and 0 at 1,024
    dimensions and above. Under a filter, the engine counts only the candidates that pass the
    filter.
    """
    oversample: int | float | None = None
    """The engine re-scores this many times k candidates in a quantized field against the
    full-precision vectors before it returns the best `limit`, where k is one more than the
    number of hits up to the end of the page, so k is `limit` plus 1 on a first page. For a
    value below 1, or for a value that is not a finite number, the engine throws a `NarsilError`
    with code `CONFIG_INVALID`. The engine ignores it on a field whose quantization is `none`.
    When a query leaves it unset, the engine sets the number of candidates that it re-scores
    from k and from the field's dimension. It rounds that number up, and it re-scores at least
    3k candidates under `osq1` and `osq2`, and at least k under `osq4` and `osq8`. Below 768
    dimensions, it re-scores 3.23k + 55.9√k under `osq1` and 2.6k + 22.5√k under `osq2`. From
    768 to 1,023 dimensions, it re-scores 2.2k + 27√k under `osq1` and k + 16√k under `osq2`,
    and under `osq2` it re-scores at least the smaller of k + 75 and k + 18√k. At 1,024
    dimensions and above, it re-scores 3k under both. Under `osq4`, it re-scores 5k below 1,024
    dimensions and 2k from 1,024 dimensions, while under `osq8` it re-scores 2k at every
    dimension. Under a filter, the engine counts only the candidates that pass the filter. On
    vectors spread evenly across every dimension, a one-bit or two-bit code can find fewer than
    95% of the true nearest neighbours at these defaults, so raise `oversample` on a query that
    needs more of them.
    """


class HttpQueryParams(ApiModel):
    """Everything `POST /indexes/{name}/search` accepts, which is QueryParams with a `group` that
    holds no reducer, because a function cannot cross JSON.
    """

    term: str | None = None
    """The engine analyses this text with the index's language module and searches for the terms
    that result. Words inside double quotes form a phrase, which a document has to hold side by
    side and in that order inside one field. The engine throws `SEARCH_INVALID_PHRASE` for a
    phrase of more than 32 words, for more than 32 phrases, and for a phrase on an index with
    `trackPositions` off. It throws `SEARCH_PHRASE_NOT_READY` while an index with a `string[]`
    field waits for a rebuild.
    """
    fields: list[str] | None = None
    """The engine searches the term in these fields, and in every text field in the schema by
    default.
    """
    filters: FilterExpression | None = None
    """The engine scores only the documents that pass this filter. It throws
    `SEARCH_INVALID_FILTER` for an operand of the wrong shape, and for an operator on a field of
    another type, such as `startsWith` on a number field.
    """
    boost: dict[str, int | float] | None = None
    """The engine multiplies the score from each named field by its weight. It throws
    `SEARCH_INVALID_FIELD` for any field other than a text field that the schema declares, and
    `CONFIG_INVALID` for a weight that is not a finite number.
    """
    bm25: BM25Params | None = None
    """These BM25 parameters score this search alone, and they override the index's parameters, so
    a `k1` here also overrides a `k1` that the index sets for a field. The engine validates them
    on every search, and it throws the same errors as IndexConfig.bm25 , except
    `SEARCH_INVALID_FIELD` for a name in `fields` that is not a text field. They change no score
    on a vector search, and on a hybrid search they apply to the keyword ranking alone. A cursor
    pages only a search with the same parameters.
    """
    scoring: Annotated[Literal["local", "dfs", "broadcast"], OPEN_ENUM] | None = None
    """The engine gathers term statistics this way, and follows the index's `defaultScoring` where
    the query sets none.
    """
    min_score: int | float | None = Field(default=None, alias="minScore")
    """The engine drops any hit scoring below this value. It ranks with BM25, which has no fixed
    upper bound, so a floor that suits one index and one query can reject every hit in another.
    """
    term_match: Annotated[Literal["all", "any"], OPEN_ENUM] | int | float | None = Field(
        default=None, alias="termMatch"
    )
    """The engine keeps a document only where the document matches this many query terms, under the
    same `tolerance` and `prefixLength` that the search uses. One term is enough by default.
    """
    tolerance: int | float | None = None
    """The engine matches an indexed term within this edit distance of a query term, so it finds a
    document for a query with a typo. It counts each Unicode code point as one character. Set an
    integer from 0 to 10.
    """
    prefix_length: int | float | None = Field(default=None, alias="prefixLength")
    """The engine applies `tolerance` only to the indexed terms that share this many leading
    characters with the query term, or to the terms that start with the whole query term when
    the query term is shorter. Set an integer from 0 to 1,024; the default is 2.
    """
    prefix: bool | None = None
    """With this set, the engine treats the last query term as an unfinished word, so `secur`
    matches `security`. The engine matches that last term by its stem or by completing it, while
    `tolerance` applies only to the earlier terms, which have to match whole. The engine scores
    completions against a shared document frequency. It also ranks them below whole-word
    matches. The engine ignores this setting where `exact` is true, and the setting is false by
    default.
    """
    partial_words: bool | None = Field(default=None, alias="partialWords")
    """With this set, the engine also matches each query word of three or more characters inside
    the longer words of every field whose type includes `partial`, so a search for `proof`
    matches a document with `waterproof` in such a field. The engine counts each Unicode code
    point as one character. It looks for the query word, before stemming, inside each word
    exactly as that word appears in a document. The engine adds at most 50 such words to a
    query, which it divides as evenly as it can among the query words. Within the share of each
    query word, it adds first the words that the most documents contain. It scores a match
    inside a longer word in proportion to the part of that word that the query word makes up, so
    it scores such a match below a whole-word match at the same frequency in a field of the same
    length. With `highlight`, it tags each whole word that contains a query word in a searched
    `partial` field. The engine applies no `tolerance` to these matches. It ignores this setting
    where `exact` is true or where the searched fields include no `partial` field. Where the
    setting is absent, the engine treats it as false, while it throws `CONFIG_INVALID` for any
    value other than `true` or `false`.
    """
    exact: bool | None = None
    """With this set, the engine matches each query term only against an equal indexed term, so it
    turns off fuzzy matching, prefix completion, partial-word matching, and synonyms. The engine
    still stems the query, because the index stores stemmed terms, so a search for `running`
    matches a document that contains `runs` through the stem that both words share.
    """
    facets: FacetConfig | None = None
    """The engine counts the values of these fields across the matching documents, and each entry
    sets how it cuts and sorts that field's counts. For a field outside the schema, it counts
    the values that the documents store. It throws `SEARCH_INVALID_FIELD` for a `geopoint` or a
    vector field.
    """
    sort: dict[str, Annotated[Literal["asc", "desc"], OPEN_ENUM]] | list[SortField] | None = None
    """The engine sorts the hits by the values of these fields, in place of the relevance ranking.
    Pass an object keyed by field, or a list of fields in the order that the engine compares
    them. The engine sorts by a `number`, `boolean`, or `enum` field, by a text field whose type
    includes `sortable`, or by a list of any of these, which it reduces to one value by the
    entry's `mode`. It throws `SEARCH_INVALID_FIELD` for a sort on a `geopoint` or a vector
    field, because neither type has an order. It throws the same code for a sort on any other
    text field, since the engine keeps up to the first 512 code points of every document's value
    in memory to sort by a text field. The engine orders hybrid results by fusion, so it throws
    `SEARCH_INVALID_MODE` for a sort on a hybrid query. It also throws that code for a direction
    other than `asc` and `desc`.
    """
    limit: int | float | None = None
    """The query returns this many hits, and 10 by default. Pass 0 to read the match count with no
    hits. The engine reads a value below 0 as 0. It falls back to the default for `NaN` and for
    an infinite value, so a page size that you compute from user input never fails the query.
    """
    offset: int | float | None = None
    """The query skips this many hits before returning. A deep offset costs more than a cursor."""
    search_after: str | None = Field(default=None, alias="searchAfter")
    """This cursor comes from a previous result's `cursor`, and pages without an offset's cost."""
    highlight: HighlightConfig | None = None
    """These settings name the fields that come back with highlighted snippets."""
    pinned: list[HttpQueryParamsPinnedItem] | None = None
    """These documents take fixed positions, ahead of the ranking."""
    mode: Annotated[Literal["vector", "hybrid", "fulltext"], OPEN_ENUM] | None = None
    """This picks which engine answers the query. Keyword search runs by default."""
    vector: VectorQueryConfig | None = None
    """These vector-search inputs are required in `vector` and `hybrid` mode."""
    hybrid: HybridConfig | None = None
    """These settings control how the keyword and vector rankings merge in `hybrid` mode."""
    rerank: RerankConfig | None = None
    """These settings reorder the top hits with a rerank adapter, such as a cross-encoder, after
    the keyword, vector, or hybrid ranking. The count matches the count of the same query
    without `rerank`, while the facets and the groups come from the first ranking. The engine
    throws `SEARCH_INVALID_MODE` for a query that also sets a sort, and `RERANK_FAILED` where
    the adapter fails or outlasts the engine's `rerankTimeout`.
    """
    include_scores: bool | None = Field(default=None, alias="includeScores")
    """Setting this returns relevance scores on a sorted query. A query that names a sort ranks by
    sort values alone and computes no scores, so its hits carry none until this restores them. A
    query without a sort ignores this and always carries scores.
    """
    include_score_components: bool | None = Field(default=None, alias="includeScoreComponents")
    """Setting this returns the numbers behind each hit's score, which is what you read when a
    ranking surprises you.
    """
    document: bool | HttpQueryParamsDocumentObject | None = None
    """This chooses how much of each stored document comes back, and the whole document by default.
    """
    group: HttpQueryParamsGroup | None = None
    """These settings collapse the hits into groups by field value."""


class QueryCoverage(ApiModel):
    """How much of an index one search read, which is what you check before you trust a count or a
    ranking. An embedded engine reads every partition it holds, so `queriedPartitions` matches
    `totalPartitions` there and the other two stay zero. A search across a cluster may find a
    node slow or unreachable, which it counts here while still returning the hits the other
    nodes gave it.
    """

    total_partitions: int | float = Field(alias="totalPartitions")
    """The search should have read this many partitions."""
    queried_partitions: int | float = Field(alias="queriedPartitions")
    """The search read this many of them."""
    timed_out_partitions: int | float = Field(alias="timedOutPartitions")
    """The search counts a partition here when the node holding it took longer than the query
    allowed.
    """
    failed_partitions: int | float = Field(alias="failedPartitions")
    """The search counts a partition here when the node holding it returned an error, and when no
    active replica served it.
    """


class HttpQueryResult(ApiModel):
    """The body of `POST /indexes/{name}/search`."""

    facets: dict[str, FacetResult] | None = None
    """These facet counts are keyed by the field each facet was asked for."""
    count: int | float
    """This many documents match in total, before the engine applies `limit` and `offset`. For a
    keyword search the engine counts every match. For a vector search it counts every vector
    that passes the query's filter and its `similarity` floor, which is every vector in the
    field where the query sets neither of them. The engine also counts each pinned document that
    the query does not match, since it places that document among the hits.
    """
    count_exact: bool = Field(alias="countExact")
    """`count` holds the exact number of matches where this is true, and a number at or below the
    true total where it is false. Where a query sets a `similarity` floor on a vector field that
    holds a graph, the engine counts only the vectors that it fetches, because it compares the
    query with only a fraction of that field's vectors. For a hybrid query the engine fuses two
    rankings, so the count is exact only where each of those rankings contains every matching
    document. Where you pin a document from outside the hits that the engine fetches, the engine
    reports true only where it holds every match of the query, because only then can it test
    whether the query matches that document.
    """
    elapsed: int | float
    """The engine spent this many milliseconds on the search."""
    cursor: str | None = None
    """This opaque cursor reaches the next page. Pass it back as `searchAfter`."""
    analysis_stale: bool | None = Field(default=None, alias="analysisStale")
    """This turns true when the index's terms came from an older analysis than its language module
    produces now.
    """
    coverage: QueryCoverage
    """The search read this much of the index, which is how you spot a degraded answer."""
    hits: list[Hit]
    """These hits follow the search's ranking, with scores encoded for HTTP."""
    groups: list[HttpGroupResult] | None = None
    """These groups arrive when the query asked for grouping."""


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
    held_search_states: int | float | None = Field(default=None, alias="heldSearchStates")
    """This many searches on this instance's main copy hold a state of the index open right now.
    Each search holds one state from its start until it answers, fails, or is cancelled, so the
    figure falls back to 0 once every search has finished. A cluster reports no figure.
    """


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


class ManualQuerySuggestion(ApiModel):
    """A suggestion that a caller adds by hand."""

    group: str
    """The group whose suggestions index takes the phrase."""
    query: str
    """The phrase, which the engine normalises."""
    count: int | float | None = None
    """The count that ranks the phrase. Defaults to 0."""


class ManualSuggestionResponse(ApiModel):
    """The answer of `POST /indexes/{name}/query-suggestions/manual`."""

    index_name: str = Field(alias="indexName")
    """The suggestions index that holds the phrase."""


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


class MemoryStatsResponse(ApiModel):
    """The body `GET /stats/memory` answers with, which is the engine's MemoryStats plus the number
    of worker threads the server receives requests on. Only the server can report that count,
    because it starts those threads.
    """

    request_threads: int | float = Field(alias="requestThreads")
    """This many worker threads receive requests and answer searches from the copies they hold. The
    count is zero where the main thread answers everything itself, which happens under
    `workers.enabled: false`, on a runtime without worker threads, and on a cluster node's
    engine. See NarsilServer.requestThreadCount .
    """
    process: ProcessMemoryReport | None
    """V8 heap usage for the host process at the moment of the call. It covers the whole process,
    so every Narsil engine in one process returns the same `process` figures from
    `getMemoryStats`. `null` in browsers and in any runtime that does not expose
    `process.memoryUsage`.
    """
    estimated_index_bytes: int | float = Field(alias="estimatedIndexBytes")
    """The sum of every index's IndexStats.estimatedMemoryBytes held by this engine. A formula
    produces it, so read it as an estimate. It compares engines inside one process, where
    `process.heapUsed` cannot tell them apart.
    """
    open_index_count: int | float = Field(alias="openIndexCount")
    """This many indexes currently occupy engine memory."""
    closed_index_count: int | float = Field(alias="closedIndexCount")
    """This many indexes remain registered without occupying engine memory, including parked
    recovery failures.
    """
    reopen_count: int | float = Field(alias="reopenCount")
    """This counts successful index loads since this engine started."""
    worker_copies: list[WorkerCopyReport] = Field(alias="workerCopies")
    """One entry per index, saying whether it holds worker copies now and how many times it has
    reloaded them.
    """
    held_checkpoints: list[HeldCheckpointReport] = Field(alias="heldCheckpoints")
    """One entry per index whose checkpoints wait until a failed partition recovers."""
    workers: list[MemoryStatsResponseWorkersItem]
    """Per-worker V8 heap usage once the engine has started its worker pool. Empty while no worker
    is running.
    """


class MultiGetBody(ApiModel):
    """The body of `POST /indexes/{name}/documents/_multi-get`."""

    doc_ids: list[str] = Field(alias="docIds")
    """The server fetches the documents with these ids."""


class MultiGetResponse(ApiModel):
    """The body of `POST /indexes/{name}/documents/_multi-get`."""

    documents: dict[str, AnyDocument]
    """Each document found appears under its id, and an id with no document has no entry."""


class OkResponse(ApiModel):
    """The body of a request that the server finishes with nothing further to report."""

    ok: bool
    """This is always true."""


class PreflightResult(ApiModel):
    """What Narsil.preflight returns: how many documents a query matches, without building or
    ranking a single hit.
    """

    count: int | float
    """The query matches this many documents."""
    count_exact: bool = Field(alias="countExact")
    """`count` holds the exact number of matches where this is true, and a number at or below the
    true total where it is false, under the rule in QueryResult.countExact.
    """
    elapsed: int | float
    """The count took this many milliseconds."""
    analysis_stale: bool | None = Field(default=None, alias="analysisStale")
    """This turns true when the index's terms came from an older analysis than its language module
    produces now.
    """


class QueryBansBody(ApiModel):
    """The body of `GET` and of `PUT /indexes/{name}/query-suggestions/bans`."""

    bans: list[str]
    """The banned phrases, at most 1,000, which the engine normalises."""


class QuerySuggestionPreviewEntry(ApiModel):
    """One phrase that a build would publish."""

    group: str
    """The group whose suggestions index would hold the phrase."""
    query: str
    """The normalised phrase."""
    count: int | float
    """The number of people whose searches the counts hold."""


QuerySuggestionsBuildTrigger: TypeAlias = Annotated[Literal["schedule", "missed", "caller"], OPEN_ENUM]
"""What started a build."""


class QuerySuggestionsBuild(ApiModel):
    """One build of the suggestions of an index."""

    build_id: str = Field(alias="buildId")
    """The ID of the build."""
    trigger: QuerySuggestionsBuildTrigger
    """What started the build."""
    status: Annotated[Literal["running", "failed", "completed", "skipped"], OPEN_ENUM]
    """Where the build stands."""
    started_at: int | float = Field(alias="startedAt")
    """When the build started, in milliseconds since the Unix epoch."""
    ended_at: int | float | None = Field(alias="endedAt")
    """When the build ended, or null while it runs."""
    published: int | float
    """The phrases that the build added or updated."""
    removed: int | float
    """The phrases that the build removed."""
    discarded: int | float
    """The phrases that the build left out because the merge held its limit."""
    error_code: str | None = Field(alias="errorCode")
    """The error code of a failed build, or null."""


class QuerySuggestionsPreview(ApiModel):
    """What the next build would publish: the phrases that enough people searched for, that match
    enough documents, and that fall in a group the build keeps.
    """

    entries: list[QuerySuggestionPreviewEntry]
    """The phrases, most counted first."""
    truncated: bool
    """True where the list stops at the limit that the caller passed while more phrases wait to be
    checked.
    """


class QuerySuggestionsSetting(ApiModel):
    """The popular query suggestions setting of one index. Only `enabled` and `fields` are
    required, and each limit that you leave out takes its default.
    """

    enabled: bool
    """Set this to true to count searches for the index and build its suggestions."""
    fields: list[str]
    """The `string` and `string[]` fields whose text a phrase must match before the engine
    publishes it.
    """
    min_people: int | float | None = Field(default=None, alias="minPeople")
    """The number of people, from 2 to 4,096, who must search a phrase before the engine publishes
    it. Defaults to 4.
    """
    min_results: int | float | None = Field(default=None, alias="minResults")
    """The number of documents, from 1 to 10,000, that a phrase must match with every word.
    Defaults to 5.
    """
    retention_days: int | float | None = Field(default=None, alias="retentionDays")
    """The number of days, from 1 to 365, that the engine keeps the counts of a day. Defaults to
    30.
    """
    max_phrases_per_day: int | float | None = Field(default=None, alias="maxPhrasesPerDay")
    """The number of phrases, up to 16,384, that a node counts for the index each day. Defaults to
    10,000.
    """
    max_phrases_per_person: int | float | None = Field(default=None, alias="maxPhrasesPerPerson")
    """The number of phrases, up to 1,000, that a node counts for one person each day. Defaults to
    100.
    """
    max_people_per_day: int | float | None = Field(default=None, alias="maxPeoplePerDay")
    """The number of people, up to 100,000, that a node counts for the index each day. Defaults to
    100,000.
    """
    max_groups: int | float | None = Field(default=None, alias="maxGroups")
    """The number of groups, up to 1,000, that the index counts. Defaults to 100."""
    min_letters: int | float | None = Field(default=None, alias="minLetters")
    """The number of letters that a phrase must hold. Defaults to 4."""
    max_length: int | float | None = Field(default=None, alias="maxLength")
    """The number of characters, up to 150, that a phrase may hold. Defaults to 100."""
    max_words: int | float | None = Field(default=None, alias="maxWords")
    """The number of words, up to 50, that a phrase may hold. Defaults to 8."""
    max_digits: int | float | None = Field(default=None, alias="maxDigits")
    """The number of digits that a phrase may hold in total. Defaults to 5."""
    max_merge_phrases: int | float | None = Field(default=None, alias="maxMergePhrases")
    """The number of phrases, up to 500,000, that one build merges. Defaults to 100,000."""
    merge_memory_bytes: int | float | None = Field(default=None, alias="mergeMemoryBytes")
    """The memory, from 16 MiB to 1 GiB, of the worker that merges the counts. Defaults to 128 MiB.
    """
    save_interval_ms: int | float | None = Field(default=None, alias="saveIntervalMs")
    """How often, from 1 second to 1 hour, a node saves the counts of the day. Defaults to 5
    minutes.
    """
    result_checks_per_second: int | float | None = Field(default=None, alias="resultChecksPerSecond")
    """The number of result checks, up to 1,000, that a build runs each second. Defaults to 20."""
    schedule: str | None = None
    """A cron expression of five fields, or `off`. Defaults to `0 3 * * *`."""
    time_zone: str | None = Field(default=None, alias="timeZone")
    """The IANA time zone of `schedule`. Defaults to `UTC`."""


class QuerySuggestionsStatus(ApiModel):
    """The setting, the last build, and the next scheduled build of one index."""

    index_name: str = Field(alias="indexName")
    """The index."""
    setting: QuerySuggestionsSetting | None
    """The setting, or null where nobody set one."""
    last_build: QuerySuggestionsBuild | None = Field(alias="lastBuild")
    """The last build, or null where none ran."""
    next_build_at: int | float | None = Field(alias="nextBuildAt")
    """When the schedule next matches, in milliseconds since the Unix epoch, or null where it is
    off.
    """
    suggestion_indexes: list[str] = Field(alias="suggestionIndexes")
    """The suggestions index of each group that holds one."""


class ReadinessResponse(ApiModel):
    """The body of `GET /readyz` and `GET /health`, which the server sends with status 200 while it
    is ready and with status 503 while it is not.
    """

    status: Annotated[Literal["ready", "unavailable"], OPEN_ENUM]
    """This says whether the server can take requests now."""
    cluster: ClusterNodeReport | None = None
    """A server that fronts a cluster node describes that node here."""


class RebalanceBody(ApiModel):
    """The body of `POST /indexes/{name}/_rebalance`."""

    target_partition_count: int | float | None = Field(default=None, alias="targetPartitionCount")
    """The index moves to this many partitions, which must be a positive whole number."""


class RecordQueryBody(ApiModel):
    """The body of `POST /indexes/{name}/query-suggestions/record`. The server takes the person and
    the group from its `identify` function, so the body carries the search alone.
    """

    query: str
    """The search that the person followed with a click."""


RecordQueryOutcome: TypeAlias = Annotated[
    Literal[
        "recorded",
        "repeat",
        "invalid",
        "banned",
        "person-limit",
        "phrase-limit",
        "people-limit",
        "group-limit",
        "no-key",
        "unidentified",
    ],
    OPEN_ENUM,
]
"""Why a node counted no search, or `recorded` where it counted one."""


class RecordQueryResult(ApiModel):
    """What QuerySuggestions.recordQuery did with one search."""

    recorded: bool
    """True where the node counted the search."""
    outcome: RecordQueryOutcome
    """Why the node counted it or left it out."""


class RemoveQueryBody(ApiModel):
    """The body of `POST /indexes/{name}/query-suggestions/remove`."""

    query: str
    """The phrase to ban and to remove from every suggestions index of the index."""


class RemoveQueryResponse(ApiModel):
    """The answer of `POST /indexes/{name}/query-suggestions/remove`."""

    suggestion_indexes: int | float = Field(alias="suggestionIndexes")
    """The number of suggestions indexes that held the phrase."""


class ReplicationFactorBody(ApiModel):
    """The body that `PUT /indexes/{name}/replication-factor` takes."""

    replication_factor: int | float = Field(alias="replicationFactor")
    """Each partition keeps this many replicas besides its primary."""


class ReplicationFactorResponse(ApiModel):
    """The body of `PUT /indexes/{name}/replication-factor`."""

    index_name: str = Field(alias="indexName")
    """The request changed the index with this name."""
    replication_factor: int | float = Field(alias="replicationFactor")
    """Each partition now keeps this many replicas besides its primary."""


class RestoreBackupBody(ApiModel):
    """The body of `POST /backups/{backup}/_restore`."""

    index_name: str = Field(alias="indexName")
    """The restore creates the index under this name, and it fails where the name is taken."""
    replication_factor: int | float | None = Field(default=None, alias="replicationFactor")
    """The restored index keeps this many replicas of each partition, or the backup's number when
    you leave it out.
    """
    constraints: AllocationConstraints | None = None
    """The rules that place the restored partitions, or the backup's rules when you leave them out.
    """


class SuggestParams(ApiModel):
    """Everything Narsil.suggest accepts."""

    prefix: str
    """The returned terms complete this text."""
    limit: int | float | None = None
    """The lookup returns this many completions, most widely used first, and 10 by default."""


class SuggestResultTermsItem(ApiModel):
    """The shape of one item of the `terms` field of `SuggestResult`."""

    term: str
    """This is the completed term, as the index holds it."""
    document_frequency: int | float = Field(alias="documentFrequency")
    """The term appears in this many documents, which is what ordered the list."""


class SuggestResult(ApiModel):
    """What Narsil.suggest returns: the indexed terms that complete a prefix, ready to offer as
    you-type suggestions.
    """

    terms: list[SuggestResultTermsItem]
    """These completions run most widely used first."""
    elapsed: int | float
    """The lookup took this many milliseconds."""
    analysis_stale: bool | None = Field(default=None, alias="analysisStale")
    """This turns true when the index's terms came from an older analysis than its language module
    produces now.
    """


class SyncSetting(ApiModel):
    """The device sync setting of one index, which SyncOperations.updateSync takes. Turn sync on
    only for an index whose every document belongs to one user, because every device that syncs
    the index receives the whole index. Create one index for each user, and leave sync off for a
    public index or for an index that holds the data of several users.
    """

    enabled: bool
    """This turns sync on or off. Turning it on gives the index a new epoch, so every synced device
    loads a new copy.
    """
    history_max_age_ms: int | float | None = Field(default=None, alias="historyMaxAgeMs")
    """This is the age in milliseconds after which the server deletes a log segment from history.
    It defaults to 30 days.
    """
    history_max_bytes: int | float | None = Field(default=None, alias="historyMaxBytes")
    """This is the byte count above which the server deletes the oldest log segment from history.
    It defaults to the length of the published snapshot.
    """


class SyncStatus(ApiModel):
    """The device sync state of one index, which SyncOperations.getSync returns."""

    active: bool
    """This is true once a device has asked for the published snapshot, from when the server keeps
    history.
    """
    epoch: str | None
    """This is the index epoch, 32 lowercase hexadecimal digits, or `null` while sync is off."""
    enabled: bool
    """This turns sync on or off. Turning it on gives the index a new epoch, so every synced device
    loads a new copy.
    """
    history_max_age_ms: int | float | None = Field(default=None, alias="historyMaxAgeMs")
    """This is the age in milliseconds after which the server deletes a log segment from history.
    It defaults to 30 days.
    """
    history_max_bytes: int | float | None = Field(default=None, alias="historyMaxBytes")
    """This is the byte count above which the server deletes the oldest log segment from history.
    It defaults to the length of the published snapshot.
    """


class SynonymSetBody(ApiModel):
    """The body of `GET /indexes/{name}/synonyms`, and the body that `POST
    /indexes/{name}/synonyms` takes.
    """

    synonyms: list[SynonymRule]
    """These rules make up the set, with every word as it was written, and an empty list removes
    the set.
    """


class TaskProgress(ApiModel):
    """How far a running import has gone, which is what a progress bar reads. The byte counts
    describe the request body, so they give an honest fraction from the first batch onwards,
    while the document counts only cover what the server has already handed to the engine. Task
    types other than `import` report no progress.
    """

    indexed: int | float
    """The server has indexed this many documents so far."""
    failed: int | float
    """The server has rejected this many documents so far."""
    bytes_processed: int | float = Field(alias="bytesProcessed")
    """The server has read this many bytes of the body so far."""
    bytes_total: int | float = Field(alias="bytesTotal")
    """The body holds this many bytes in total."""


TaskStatus: TypeAlias = Annotated[Literal["running", "succeeded", "failed", "cancelled"], OPEN_ENUM]
"""Where a long-running operation stands. A task starts `running`, because the server begins the work
as it accepts the request. Where the server already drives ServerLimits.maxConcurrentTasks tasks, it
answers 429 `TOO_MANY_REQUESTS` and starts none. A task reaches `cancelled` only where the work
itself stops early, so a cancel that arrives too late leaves the task `succeeded`.
"""


class TaskStepProgress(ApiModel):
    """How far a task that works through a known number of steps has gone. A `backup` and a
    `backupRestore` task count partitions, and a `backupDelete` task counts the files it
    removes.
    """

    done: int | float
    """The task has finished this many steps."""
    total: int | float
    """The task covers this many steps, and 0 until it knows."""


TaskType: TypeAlias = Annotated[
    Literal[
        "optimizeVectors",
        "rebalance",
        "restore",
        "import",
        "importExport",
        "rebuildAnalysis",
        "changeAnalysis",
        "backup",
        "backupRestore",
        "backupDelete",
        "querySuggestionsBuild",
    ],
    OPEN_ENUM,
]
"""Which long-running operation a task record tracks."""


class TaskRecord(ApiModel):
    """One long-running operation, which the server answers with straight away and you then poll.
    Every route that starts a task answers with this same record, and `GET /tasks/{id}` returns
    it again as the work moves on.
    """

    id: str
    """This identifies the task, and is what you poll by."""
    type: TaskType
    """This says which operation the task runs."""
    index_name: str = Field(alias="indexName")
    """The operation runs against this index. A `backupRestore` task names the index it creates,
    and a `backupDelete` task names none and carries an empty string.
    """
    backup_name: str | None = Field(default=None, alias="backupName")
    """A `backup`, `backupRestore`, or `backupDelete` task works on the backup of this name."""
    status: TaskStatus
    """This says where the operation stands."""
    owner: str
    """Identifier of the server instance running this task; see ServerOptions.instanceId."""
    created_at: int | float = Field(alias="createdAt")
    """The server accepted the task at this many milliseconds since the epoch."""
    started_at: int | float | None = Field(default=None, alias="startedAt")
    """Work started at this many milliseconds since the epoch."""
    completed_at: int | float | None = Field(default=None, alias="completedAt")
    """Work ended at this many milliseconds since the epoch, and a task omits it until it reaches a
    final status.
    """
    cancel_requested_at: int | float | None = Field(default=None, alias="cancelRequestedAt")
    """A cancel arrived at this many milliseconds since the epoch, which is how a task still
    running shows that it is stopping.
    """
    progress: TaskProgress | None = None
    """How far the work has gone, which an import reports and other task types omit."""
    steps: TaskStepProgress | None = None
    """How many of its steps the work has finished, which a backup, a backup restore, and a backup
    deletion report.
    """
    result: ImportResult | None = None
    """What the work produced, which an `import` or `importExport` task reports once it finishes."""
    build: QuerySuggestionsBuild | None = None
    """The build that a `querySuggestionsBuild` task ran, once it ends."""
    error: ErrorDetail | None = None
    """This says why the task failed, and a failed task alone carries it."""


class TaskListPage(ApiModel):
    """One page of task records, ordered newest first."""

    tasks: list[TaskRecord]
    """The records this page carries."""
    total: int | float
    """How many records the filters matched in total, across every page."""
    from_: int | float = Field(alias="from")
    """This page skipped this many records."""
    limit: int | float
    """This page asked for this many records."""
    next: int | float | None
    """Pass this back as `from` for the next page, and it is null on the last page."""


class VectorFieldBody(ApiModel):
    """The body that `POST /indexes/{name}/vectors/_compact` and `POST
    /indexes/{name}/vectors/_optimize` take.
    """

    field: str | None = None
    """The request covers this vector field, and every vector field of the index where you leave it
    out.
    """


class VectorMaintenanceResult(ApiModel):
    """The state of one vector field, and what maintenance would cost, as
    VectorMaintenanceOperations.vectorMaintenanceStatus reports it. Removing a vector leaves a
    tombstone in the graph, and enough of them slow a search down. Read this to decide when
    compaction earns its cost.
    """

    field_name: str = Field(alias="fieldName")
    """This describes the named vector field."""
    tombstone_ratio: int | float = Field(alias="tombstoneRatio")
    """Tombstones make up this share of the graph's nodes, from 0 to 1. Before the first build,
    where VectorMaintenanceResult.graphCount reads 0, the engine divides by the number of stored
    vectors, because no graph exists yet.
    """
    graph_count: int | float = Field(alias="graphCount")
    """The field holds this many HNSW graphs: 0 before the first build and 1 once a graph exists."""
    buffer_size: int | float = Field(alias="bufferSize")
    """This many vectors wait outside the graph, which a search scans one by one."""
    building: bool
    """This stays true while a graph build runs."""
    waiting_for_memory: bool = Field(alias="waitingForMemory")
    """This turns true while a rebuild that keeps recall up waits for the node to have room for a
    second graph beside the one it serves, and false once it starts.
    """
    loading_from_files: bool = Field(alias="loadingFromFiles")
    """This stays true after a restart while a field kept on disk loads its codes and graph in the
    background, during which a search reads them from the field's files.
    """
    estimated_compact_ms: int | float = Field(alias="estimatedCompactMs")
    """VectorMaintenanceOperations.compactVectors would take about this many milliseconds."""
    estimated_optimize_ms: int | float = Field(alias="estimatedOptimizeMs")
    """VectorMaintenanceOperations.optimizeVectors would take about this many milliseconds."""


class VectorMaintenanceResponse(ApiModel):
    """The body of `GET /indexes/{name}/vector-maintenance`."""

    fields: list[VectorMaintenanceResult]
    """One entry describes each vector field of the index."""


class VersionResponse(ApiModel):
    """The body of `GET /version`."""

    name: Annotated[Literal["narsil"], OPEN_ENUM]
    """This is always `narsil`."""
    version: str | None
    """The build came from this package version, or this is null where the build stamped none."""
    git_sha: str | None = Field(alias="gitSha")
    """The build came from this git commit, or this is null where the build stamped none."""
    dirty: bool
    """This is true when the working tree held uncommitted changes at build time."""
    vector_search: Annotated[Literal["native", "wasm"], OPEN_ENUM] = Field(alias="vectorSearch")
    """The thread that answered searches vector graphs through the native search core under
    `native`, and through WebAssembly under `wasm`.
    """


__all__ = [
    "AllocationConstraints",
    "AnyDocument",
    "ArrayFilter",
    "BM25FieldParams",
    "BM25Params",
    "BackupListResponse",
    "BackupListing",
    "BackupSummary",
    "BatchBody",
    "BatchBodyUpdatesItem",
    "BatchFailure",
    "BatchResponse",
    "CapabilitiesResponse",
    "ChangeAnalysisBody",
    "ClusterAllocationResponse",
    "ClusterHealth",
    "ClusterHealthStatus",
    "ClusterMemberReport",
    "ClusterNodeReport",
    "ClusterTopologyResponse",
    "ComparisonFilter",
    "CreateBackupBody",
    "CreateIndexEmbedding",
    "DamagedBackup",
    "DamagedBackupError",
    "DocumentBody",
    "DocumentCountResponse",
    "DocumentExistsResponse",
    "DocumentIdResponse",
    "DocumentPutResponse",
    "DocumentRemovedResponse",
    "DocumentResponse",
    "ErrorDetail",
    "ErrorEnvelope",
    "FacetConfig",
    "FacetConfigValue",
    "FacetConfigValueRangesItem",
    "FacetResult",
    "FieldFilter",
    "FieldType",
    "FilterExpression",
    "GeoPolygonFilter",
    "GeoPolygonFilterPolygon",
    "GeoPolygonFilterPolygonPointsItem",
    "GeoRadiusFilter",
    "GeoRadiusFilterRadius",
    "HeldCheckpointReport",
    "HighlightConfig",
    "HighlightMatch",
    "HighlightMatchPositionsItem",
    "Hit",
    "HttpCreateIndexBody",
    "HttpGroupResult",
    "HttpIndexBody",
    "HttpQueryParams",
    "HttpQueryParamsDocumentObject",
    "HttpQueryParamsGroup",
    "HttpQueryParamsPinnedItem",
    "HttpQueryResult",
    "HybridConfig",
    "ImportError",
    "ImportResult",
    "IndexClearedResponse",
    "IndexCreatedResponse",
    "IndexDroppedResponse",
    "IndexHealth",
    "IndexInfo",
    "IndexListResponse",
    "IndexPartitionsResponse",
    "IndexStateResponse",
    "IndexStats",
    "InsertBody",
    "InsertOptions",
    "ListParams",
    "ListParamsDocumentObject",
    "ListResult",
    "ListedDocument",
    "LivenessResponse",
    "ManualQuerySuggestion",
    "ManualSuggestionResponse",
    "MemoryStatsResponse",
    "MemoryStatsResponseWorkersItem",
    "MultiGetBody",
    "MultiGetResponse",
    "NodeMemoryReport",
    "NodeReadiness",
    "NodeRole",
    "OkResponse",
    "OneWaySynonymRule",
    "PartitionAllocationReport",
    "PartitionConfig",
    "PartitionStatsResult",
    "PreflightResult",
    "PresenceFilter",
    "ProcessMemoryReport",
    "QueryBansBody",
    "QueryCoverage",
    "QuerySuggestionPreviewEntry",
    "QuerySuggestionsBuild",
    "QuerySuggestionsBuildTrigger",
    "QuerySuggestionsPreview",
    "QuerySuggestionsSetting",
    "QuerySuggestionsStatus",
    "ReadinessResponse",
    "RebalanceBody",
    "RecordQueryBody",
    "RecordQueryOutcome",
    "RecordQueryResult",
    "RemoveQueryBody",
    "RemoveQueryResponse",
    "ReplicationFactorBody",
    "ReplicationFactorResponse",
    "RerankConfig",
    "RestoreBackupBody",
    "SchemaDefinition",
    "ScoreComponents",
    "SortField",
    "StringFilter",
    "SuggestParams",
    "SuggestResult",
    "SuggestResultTermsItem",
    "SyncSetting",
    "SyncStatus",
    "SynonymRule",
    "SynonymSetBody",
    "TaskListPage",
    "TaskProgress",
    "TaskRecord",
    "TaskStatus",
    "TaskStepProgress",
    "TaskType",
    "TwoWaySynonymRule",
    "VectorFieldBody",
    "VectorIndexConfig",
    "VectorIndexConfigHnswConfig",
    "VectorMaintenanceResponse",
    "VectorMaintenanceResult",
    "VectorQueryConfig",
    "VersionResponse",
    "WorkerCopyReport",
    "WriteOptions",
]
