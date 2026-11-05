"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from narsil_client._model import OPEN_ENUM, ApiModel


class VectorMaintenanceResult(ApiModel):
    """The state of one vector field, and what maintenance would cost, as
    Narsil.vectorMaintenanceStatus reports it. Removing a vector leaves a tombstone in the
    graph, and enough of them slow a search down. Read this to decide when compaction earns its
    cost.
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
    """Narsil.compactVectors would take about this many milliseconds."""
    estimated_optimize_ms: int | float = Field(alias="estimatedOptimizeMs")
    """Narsil.optimizeVectors would take about this many milliseconds."""


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
