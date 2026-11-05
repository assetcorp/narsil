"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import Field

from narsil_client._model import OPEN_ENUM, ApiModel
from narsil_client.models._part_01 import AllocationConstraints, AnyDocument, ErrorDetail
from narsil_client.models._part_02 import ClusterNodeReport
from narsil_client.models._part_03 import HeldCheckpointReport
from narsil_client.models._part_04 import SynonymRule
from narsil_client.models._part_06 import (
    ImportResult,
    MemoryStatsResponseWorkersItem,
    ProcessMemoryReport,
    WorkerCopyReport,
)


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
