"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from narsil_client._async_transport import AsyncOperationsBase
from narsil_client._exchange import Exchange, json_body, path_segment
from narsil_client._streams import AsyncResponseStream
from narsil_client.models import (
    ChangeAnalysisBody,
    OkResponse,
    RebalanceBody,
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
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> AsyncResponseStream:
        """Stream a snapshot archive of an index.

        `GET /indexes/{name}/snapshot`

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
                path=f"/indexes/{path_segment(name)}/snapshot",
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
