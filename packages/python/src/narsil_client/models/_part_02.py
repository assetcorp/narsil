"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import Field

from narsil_client._model import OPEN_ENUM, ApiModel
from narsil_client.models._part_01 import AnyDocument, ClusterHealthStatus, ErrorDetail


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
