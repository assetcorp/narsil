"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from narsil_client._exchange import Exchange, json_body, path_segment
from narsil_client._sync_transport import SyncOperationsBase
from narsil_client.models import (
    DocumentCountResponse,
    HttpCreateIndexBody,
    IndexClearedResponse,
    IndexCreatedResponse,
    IndexDroppedResponse,
    IndexListResponse,
    IndexPartitionsResponse,
    IndexStateResponse,
    IndexStats,
)


class IndexesOperations(SyncOperationsBase):
    """These methods call the Indexes routes of a Narsil server."""

    def list_indexes(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> IndexListResponse:
        """List every index.

        `GET /indexes`

        Args:
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            IndexListResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path="/indexes",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: IndexListResponse},
            ),
        )

    def create_index(
        self,
        body: HttpCreateIndexBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> IndexCreatedResponse:
        """Create an index.

        `POST /indexes`

        Args:
            body: The body of `POST /indexes`, which is CreateIndexRequest with the settings
                of HttpIndexBody.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 201: The server created the resource.
        """
        return cast(
            IndexCreatedResponse,
            self._transport.json(
                Exchange(
                    method="POST",
                    path="/indexes",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {201: IndexCreatedResponse},
            ),
        )

    def drop_index(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> IndexDroppedResponse:
        """Drop an index.

        `DELETE /indexes/{name}`

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
            IndexDroppedResponse,
            self._transport.json(
                Exchange(
                    method="DELETE",
                    path=f"/indexes/{path_segment(name)}",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: IndexDroppedResponse},
            ),
        )

    def get_stats(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> IndexStats:
        """Report the statistics of an index.

        `GET /indexes/{name}/stats`

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
            IndexStats,
            self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/stats",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: IndexStats},
            ),
        )

    def get_partition_stats(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> IndexPartitionsResponse:
        """Report the statistics of each partition of an index.

        `GET /indexes/{name}/partitions`

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
            IndexPartitionsResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/partitions",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: IndexPartitionsResponse},
            ),
        )

    def clear(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> IndexClearedResponse:
        """Remove every document and keep the index.

        `POST /indexes/{name}/_clear`

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
            IndexClearedResponse,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/_clear",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: IndexClearedResponse},
            ),
        )

    def open(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> IndexStateResponse:
        """Load an index into memory.

        `POST /indexes/{name}/_open`

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
            IndexStateResponse,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/_open",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: IndexStateResponse},
            ),
        )

    def close(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> IndexStateResponse:
        """Release the memory of an index.

        `POST /indexes/{name}/_close`

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
            IndexStateResponse,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/_close",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: IndexStateResponse},
            ),
        )

    def count_documents(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> DocumentCountResponse:
        """Count the documents in an index.

        `GET /indexes/{name}/count`

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
            DocumentCountResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/count",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: DocumentCountResponse},
            ),
        )
