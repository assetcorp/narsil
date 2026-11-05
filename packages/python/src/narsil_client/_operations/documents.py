"""Generated from packages/ts/openapi.json by packages/python/generator. Do not edit."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any, Literal, cast

from narsil_client._exchange import Exchange, Upload, json_body, path_segment, query_value
from narsil_client._model import OPEN_ENUM
from narsil_client._sync_transport import SyncOperationsBase
from narsil_client.models import (
    BatchBody,
    BatchResponse,
    DocumentBody,
    DocumentExistsResponse,
    DocumentIdResponse,
    DocumentPutResponse,
    DocumentRemovedResponse,
    DocumentResponse,
    ImportResult,
    InsertBody,
    ListParams,
    ListResult,
    MultiGetBody,
    MultiGetResponse,
    OkResponse,
    TaskRecord,
)


class DocumentsOperations(SyncOperationsBase):
    """These methods call the Documents routes of a Narsil server."""

    def insert(
        self,
        name: str,
        body: InsertBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> DocumentIdResponse:
        """Insert one document.

        `POST /indexes/{name}/documents`

        Args:
            name: The name of the index.
            body: The body of `POST /indexes/{name}/documents`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 201: The server created the resource.
        """
        return cast(
            DocumentIdResponse,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/documents",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {201: DocumentIdResponse},
            ),
        )

    def write_batch(
        self,
        name: str,
        body: BatchBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> BatchResponse:
        """Insert, update, or remove many documents, with a result for each.

        `POST /indexes/{name}/documents/_batch`

        Args:
            name: The name of the index.
            body: The body of `POST /indexes/{name}/documents/_batch`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            BatchResponse,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/documents/_batch",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: BatchResponse},
            ),
        )

    def list_documents(
        self,
        name: str,
        body: ListParams | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> ListResult:
        """Read one page of stored documents.

        `POST /indexes/{name}/documents/_list`

        Args:
            name: The name of the index.
            body: Everything Narsil.listDocuments accepts. Narsil.listDocuments reads the
                stored documents without ranking them, which is how you page through a whole
                index. Leave `cursor` out to start at the first document, then pass back the
                cursor each result carries until it comes back null. A cursor belongs to the
                sort it was made under, so pass the same `sort` back with it. Changing
                `sort` invalidates the cursor, and the engine then throws
                `SEARCH_INVALID_CURSOR` rather than returning a page from the wrong order.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            ListResult,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/documents/_list",
                    body=json_body(body),
                    content_type="application/json",
                    repeatable=True,
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: ListResult},
            ),
        )

    def get_multiple(
        self,
        name: str,
        body: MultiGetBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> MultiGetResponse:
        """Fetch many documents by id.

        `POST /indexes/{name}/documents/_multi-get`

        Args:
            name: The name of the index.
            body: The body of `POST /indexes/{name}/documents/_multi-get`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            MultiGetResponse,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/documents/_multi-get",
                    body=json_body(body),
                    content_type="application/json",
                    repeatable=True,
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: MultiGetResponse},
            ),
        )

    def import_ndjson(
        self,
        name: str,
        body: Upload,
        *,
        async_: Annotated[Literal["true", "false"], OPEN_ENUM] | None = None,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> ImportResult | TaskRecord:
        """Load newline-delimited documents, inside the request or as a task.

        `POST /indexes/{name}/documents/_import`

        Args:
            name: The name of the index.
            body: The client sends these bytes as `application/x-ndjson`.
            async_: Under `true`, the server starts a task and answers 202 with its record.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
            HTTP 202: The server accepted the work and started a task.
        """
        return cast(
            ImportResult | TaskRecord,
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/documents/_import",
                    query={"async": query_value(async_)},
                    body=body,
                    content_type="application/x-ndjson",
                    carries_corpus=True,
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: ImportResult, 202: TaskRecord},
            ),
        )

    def wait_for_writes(
        self,
        name: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> OkResponse:
        """Wait until every worker copy has applied the writes that returned before this
        request.

        `POST /indexes/{name}/_wait-for-writes`

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
            self._transport.json(
                Exchange(
                    method="POST",
                    path=f"/indexes/{path_segment(name)}/_wait-for-writes",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: OkResponse},
            ),
        )

    def get(
        self,
        name: str,
        id: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> DocumentResponse:
        """Read one document.

        `GET /indexes/{name}/documents/{id}`

        Args:
            name: The name of the index.
            id: The id of the document.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            DocumentResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/documents/{path_segment(id)}",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: DocumentResponse},
            ),
        )

    def put(
        self,
        name: str,
        id: str,
        body: DocumentBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> DocumentPutResponse:
        """Write one document under the id, whether or not the id exists.

        `PUT /indexes/{name}/documents/{id}`

        Args:
            name: The name of the index.
            id: The id of the document.
            body: The body of `PUT` and of `PATCH /indexes/{name}/documents/{id}`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
            HTTP 201: The server created the resource.
        """
        return cast(
            DocumentPutResponse,
            self._transport.json(
                Exchange(
                    method="PUT",
                    path=f"/indexes/{path_segment(name)}/documents/{path_segment(id)}",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: DocumentPutResponse, 201: DocumentPutResponse},
            ),
        )

    def update(
        self,
        name: str,
        id: str,
        body: DocumentBody | Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> DocumentIdResponse:
        """Update one existing document.

        `PATCH /indexes/{name}/documents/{id}`

        Args:
            name: The name of the index.
            id: The id of the document.
            body: The body of `PUT` and of `PATCH /indexes/{name}/documents/{id}`.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            DocumentIdResponse,
            self._transport.json(
                Exchange(
                    method="PATCH",
                    path=f"/indexes/{path_segment(name)}/documents/{path_segment(id)}",
                    body=json_body(body),
                    content_type="application/json",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: DocumentIdResponse},
            ),
        )

    def remove(
        self,
        name: str,
        id: str,
        *,
        wait: Annotated[Literal["true", "false"], OPEN_ENUM] | None = None,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> DocumentRemovedResponse:
        """Remove one document.

        `DELETE /indexes/{name}/documents/{id}`

        Args:
            name: The name of the index.
            id: The id of the document.
            wait: Under `true`, the server answers only once every worker copy has applied the
                removal.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            DocumentRemovedResponse,
            self._transport.json(
                Exchange(
                    method="DELETE",
                    path=f"/indexes/{path_segment(name)}/documents/{path_segment(id)}",
                    query={"wait": query_value(wait)},
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: DocumentRemovedResponse},
            ),
        )

    def has(
        self,
        name: str,
        id: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> DocumentExistsResponse:
        """Report whether an index holds a document with the id.

        `GET /indexes/{name}/documents/{id}/_exists`

        Args:
            name: The name of the index.
            id: The id of the document.
            timeout_ms: The client waits this many milliseconds for each try of this request, in place of the
                client's setting, and 0 waits for as long as the server takes.
            headers: The client adds these headers to this request, replacing any of the same name.
            max_response_bytes: The client stops reading the answer past this many bytes, in place of the
                client's setting, and 0 reads whatever the server sends.

        Returns:
            HTTP 200: The server answered the request.
        """
        return cast(
            DocumentExistsResponse,
            self._transport.json(
                Exchange(
                    method="GET",
                    path=f"/indexes/{path_segment(name)}/documents/{path_segment(id)}/_exists",
                    timeout_ms=timeout_ms,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                ),
                {200: DocumentExistsResponse},
            ),
        )
