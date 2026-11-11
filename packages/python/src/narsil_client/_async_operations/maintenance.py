"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any, Literal, cast

from narsil_client._async_transport import AsyncOperationsBase
from narsil_client._exchange import AsyncUpload, Exchange, json_body, path_segment, query_value
from narsil_client._model import OPEN_ENUM
from narsil_client._streams import AsyncResponseStream
from narsil_client.models import (
    BM25Params,
    ChangeAnalysisBody,
    OkResponse,
    PartitionConfig,
    RebalanceBody,
    SynonymSetBody,
    TaskRecord,
    VectorFieldBody,
    VectorMaintenanceResponse,
)


class MaintenanceOperations(AsyncOperationsBase):
    """These methods call the Maintenance routes of a Narsil server."""

    async def checkpoint(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> OkResponse:
        """Force a checkpoint of an index.

        `POST /indexes/{name}/_checkpoint`

        Args:
            name: The name of the index.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            OkResponse,
            await self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/_checkpoint",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: OkResponse},
            ),
        )

    async def rebuild_analysis(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Reanalyse every document of an index, as a task.

        `POST /indexes/{name}/_rebuild-analysis`

        Args:
            name: The name of the index.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 202: The server accepted the work and started a task.
        """
        return cast(
            TaskRecord,
            await self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/_rebuild-analysis",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )

    async def change_analysis(
        self,
        name: str,
        body: ChangeAnalysisBody | Mapping[str, Any] | None = None,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Change the language, stop words, or tokeniser of an index, as a task.

        `POST /indexes/{name}/_change-analysis`

        Args:
            name: The name of the index.
            body: The body of `POST /indexes/{name}/_change-analysis`, where a key that you
                leave out keeps its current value.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 202: The server accepted the work and started a task.
        """
        return cast(
            TaskRecord,
            await self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/_change-analysis",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )

    async def snapshot(
        self,
        name: str,
        *,
        query_history: Annotated[Literal["true", "false"], OPEN_ENUM] | None = None,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> AsyncResponseStream:
        """Stream a snapshot archive of an index.

        `GET /indexes/{name}/snapshot`

        Args:
            name: The name of the index.
            query_history: Under `true`, the archive also holds the index's search history.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return await self._transport.stream(
            Exchange(
                method="GET",
                path=f"/indexes/{path_segment(name)}/snapshot",
                query={"queryHistory": query_value(query_history)},
                carries_corpus=True,
                timeout_ms=timeout_ms,
                headers=headers,
                max_response_bytes=max_response_bytes,
            ),
        )

    async def vector_maintenance_status(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> VectorMaintenanceResponse:
        """Report the state of each vector field of an index.

        `GET /indexes/{name}/vector-maintenance`

        Args:
            name: The name of the index.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            VectorMaintenanceResponse,
            await self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/vector-maintenance",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: VectorMaintenanceResponse},
            ),
        )

    async def compact_vectors(
        self,
        name: str,
        body: VectorFieldBody | Mapping[str, Any] | None = None,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> OkResponse:
        """Compact the vector fields of an index.

        `POST /indexes/{name}/vectors/_compact`

        Args:
            name: The name of the index.
            body: The body that `POST /indexes/{name}/vectors/_compact` and `POST
                /indexes/{name}/vectors/_optimize` take.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            OkResponse,
            await self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/vectors/_compact",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: OkResponse},
            ),
        )

    async def optimize_vectors(
        self,
        name: str,
        body: VectorFieldBody | Mapping[str, Any] | None = None,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Rebuild the vector graphs of an index, as a task.

        `POST /indexes/{name}/vectors/_optimize`

        Args:
            name: The name of the index.
            body: The body that `POST /indexes/{name}/vectors/_compact` and `POST
                /indexes/{name}/vectors/_optimize` take.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 202: The server accepted the work and started a task.
        """
        return cast(
            TaskRecord,
            await self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/vectors/_optimize",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )

    async def rebalance(
        self,
        name: str,
        body: RebalanceBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Move an index to another partition count, as a task.

        `POST /indexes/{name}/_rebalance`

        Args:
            name: The name of the index.
            body: The body of `POST /indexes/{name}/_rebalance`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 202: The server accepted the work and started a task.
        """
        return cast(
            TaskRecord,
            await self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/_rebalance",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )

    async def update_partition_config(
        self,
        name: str,
        body: PartitionConfig | Mapping[str, Any] | None = None,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> OkResponse:
        """Change the partition settings of an index.

        `POST /indexes/{name}/partition-config`

        Args:
            name: The name of the index.
            body: How many partitions an index opens with, and how many documents it accepts.
                An index opens with `maxPartitions` partitions and keeps that count until
                Narsil.rebalance changes it, because the engine adds no partition on its
                own. Set `watermark` to learn through the `partitionWatermark` event when an
                index fills its capacity.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            OkResponse,
            await self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/partition-config",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: OkResponse},
            ),
        )

    async def get_synonyms(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> SynonymSetBody:
        """Read the synonym set of an index.

        `GET /indexes/{name}/synonyms`

        Args:
            name: The name of the index.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            SynonymSetBody,
            await self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/synonyms",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: SynonymSetBody},
            ),
        )

    async def update_synonyms(
        self,
        name: str,
        body: SynonymSetBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> OkResponse:
        """Replace the synonym set of an index.

        `POST /indexes/{name}/synonyms`

        Args:
            name: The name of the index.
            body: The body of `GET /indexes/{name}/synonyms`, and the body that `POST
                /indexes/{name}/synonyms` takes.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            OkResponse,
            await self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/synonyms",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: OkResponse},
            ),
        )

    async def update_bm25(
        self,
        name: str,
        body: BM25Params | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> OkResponse:
        """Replace the BM25 setting of an index.

        `POST /indexes/{name}/bm25`

        Args:
            name: The name of the index.
            body: BM25 tuning for an index or for one search. Both parameters default to the
                values the literature settles on, so change them only once you have measured
                relevance on your own corpus. For each field, the engine takes the first
                value that is set among the search's value for the field, the search's
                value, the index's value for the field, the index's value, and the default.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            OkResponse,
            await self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/bm25",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: OkResponse},
            ),
        )

    async def restore(
        self,
        name: str,
        body: AsyncUpload,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Restore an index from a snapshot archive, as a task.

        `POST /indexes/{name}/restore`

        Args:
            name: The name of the index.
            body: The client sends these bytes as `application/x-tar`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 202: The server accepted the work and started a task.
        """
        return cast(
            TaskRecord,
            await self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/restore",
                    body=body,
                    content_type="application/x-tar",
                    carries_corpus=True,
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )

    async def export_documents(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> AsyncResponseStream:
        """Stream a document export of an index.

        `GET /indexes/{name}/export`

        Args:
            name: The name of the index.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return await self._transport.stream(
            Exchange(
                method="GET",
                path=f"/indexes/{path_segment(name)}/export",
                carries_corpus=True,
                timeout_ms=timeout_ms,
                headers=headers,
                max_response_bytes=max_response_bytes,
            ),
        )

    async def import_document_export(
        self,
        name: str,
        body: AsyncUpload,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord:
        """Import a document export, as a task.

        `POST /indexes/{name}/import`

        Args:
            name: The name of the index.
            body: The client sends these bytes as `application/x-ndjson`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 202: The server accepted the work and started a task.
        """
        return cast(
            TaskRecord,
            await self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/import",
                    body=body,
                    content_type="application/x-ndjson",
                    carries_corpus=True,
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {202: TaskRecord},
            ),
        )
