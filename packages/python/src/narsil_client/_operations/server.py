"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast

from narsil_client._exchange import Exchange
from narsil_client._sync_transport import SyncOperationsBase
from narsil_client.models import (
    CapabilitiesResponse,
    LivenessResponse,
    MemoryStatsResponse,
    ReadinessResponse,
    VersionResponse,
)


class ServerOperations(SyncOperationsBase):
    """These methods call the Server routes of a Narsil server."""

    def is_alive(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> LivenessResponse:
        """Report that the process can serve HTTP.

        `GET /livez`

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
            LivenessResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path="/livez",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: LivenessResponse},
            ),
        )

    def is_ready(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> ReadinessResponse:
        """Report whether the server can take requests.

        `GET /readyz`

        Args:
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
            HTTP 503: The server cannot take requests now.
        """
        return cast(
            ReadinessResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path="/readyz",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: ReadinessResponse, 503: ReadinessResponse},
            ),
        )

    def health(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> ReadinessResponse:
        """Report whether the server can take requests, as /readyz does.

        `GET /health`

        Args:
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
            HTTP 503: The server cannot take requests now.
        """
        return cast(
            ReadinessResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path="/health",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: ReadinessResponse, 503: ReadinessResponse},
            ),
        )

    def version(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> VersionResponse:
        """Report the build identity of the server.

        `GET /version`

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
            VersionResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path="/version",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: VersionResponse},
            ),
        )

    def capabilities(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> CapabilitiesResponse:
        """List the optional routes and modes that this server serves.

        `GET /capabilities`

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
            CapabilitiesResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path="/capabilities",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: CapabilitiesResponse},
            ),
        )

    def get_memory_stats(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> MemoryStatsResponse:
        """Report the memory that the engine and the server use.

        `GET /stats/memory`

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
            MemoryStatsResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path="/stats/memory",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: MemoryStatsResponse},
            ),
        )
