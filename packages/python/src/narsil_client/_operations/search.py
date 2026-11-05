"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from narsil_client._exchange import Exchange, json_body, path_segment
from narsil_client._sync_transport import SyncOperationsBase
from narsil_client.models import HttpQueryParams, HttpQueryResult, PreflightResult, SuggestParams, SuggestResult


class SearchOperations(SyncOperationsBase):
    """These methods call the Search routes of a Narsil server."""

    def query(
        self,
        name: str,
        body: HttpQueryParams | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> HttpQueryResult:
        """Search an index.

        `POST /indexes/{name}/search`

        Args:
            name: The name of the index.
            body: Everything `POST /indexes/{name}/search` accepts, which is QueryParams with
                a `group` that holds no reducer, because a function cannot cross JSON.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            HttpQueryResult,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/search",
                    body=json_body(body),
                    content_type="application/json",
                    repeatable=True,
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: HttpQueryResult},
            ),
        )

    def preflight(
        self,
        name: str,
        body: HttpQueryParams | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> PreflightResult:
        """Count the documents that a search matches, with no hits.

        `POST /indexes/{name}/search/preflight`

        Args:
            name: The name of the index.
            body: Everything `POST /indexes/{name}/search` accepts, which is QueryParams with
                a `group` that holds no reducer, because a function cannot cross JSON.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            PreflightResult,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/search/preflight",
                    body=json_body(body),
                    content_type="application/json",
                    repeatable=True,
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: PreflightResult},
            ),
        )

    def suggest(
        self,
        name: str,
        body: SuggestParams | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> SuggestResult:
        """Complete a prefix from the terms of an index.

        `POST /indexes/{name}/suggest`

        Args:
            name: The name of the index.
            body: Everything Narsil.suggest accepts.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            SuggestResult,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/suggest",
                    body=json_body(body),
                    content_type="application/json",
                    repeatable=True,
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: SuggestResult},
            ),
        )
