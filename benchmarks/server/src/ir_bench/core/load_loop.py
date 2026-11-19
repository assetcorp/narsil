from __future__ import annotations

import selectors
import socket
from dataclasses import dataclass, field
from time import perf_counter

from .http_client import REQUEST_TIMEOUT_SECONDS
from .prepared_search import PreparedSearch

RECEIVE_BYTES = 262_144
SELECT_TIMEOUT_SECONDS = 0.05
HEADER_END = b"\r\n\r\n"
LINE_END = b"\r\n"
BODYLESS_STATUSES = frozenset({204, 304})
CLOSE_TOKEN = b"close"
CHUNKED_TOKEN = b"chunked"
MAX_ERROR_CAUSES = 16
ERROR_CAUSE_CHARACTERS = 200
OTHER_ERROR_CAUSES = "other causes"


class MalformedResponse(Exception):
    pass


def error_cause(stage: str, exc: BaseException) -> str:
    detail = " ".join(str(exc).split())
    described = f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__
    return f"{stage}: {described}"[:ERROR_CAUSE_CHARACTERS]


def count_error_cause(causes: dict[str, int], cause: str, count: int = 1) -> None:
    key = cause if cause in causes or len(causes) < MAX_ERROR_CAUSES else OTHER_ERROR_CAUSES
    causes[key] = causes.get(key, 0) + count


def merge_error_causes(target: dict[str, int], source: dict[str, int]) -> None:
    for cause, count in source.items():
        count_error_cause(target, cause, count)


@dataclass
class WindowResult:
    completed: int = 0
    errors: int = 0
    client_ms: list[float] = field(default_factory=list)
    server_ms: list[float] = field(default_factory=list)
    error_causes: dict[str, int] = field(default_factory=dict)

    def fail(self, cause: str) -> None:
        self.errors += 1
        count_error_cause(self.error_causes, cause)


@dataclass(frozen=True)
class ParsedResponse:
    status: int
    body: bytes
    consumed: int
    close: bool


def request_bytes(prepared: PreparedSearch) -> bytes:
    lines = [f"{prepared.method} {prepared.target} HTTP/1.1"]
    lines.extend(f"{name}: {value}" for name, value in prepared.headers.items())
    head = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")
    return head + (prepared.body or b"")


def _chunked_body(buffer: bytearray, start: int) -> tuple[bytes, int] | None:
    body = bytearray()
    position = start
    while True:
        line_end = buffer.find(LINE_END, position)
        if line_end < 0:
            return None
        size_text = bytes(buffer[position:line_end]).split(b";", 1)[0].strip()
        try:
            size = int(size_text, 16)
        except ValueError as exc:
            raise MalformedResponse(f"bad chunk size {size_text!r}") from exc
        data_start = line_end + 2
        if size == 0:
            if buffer[data_start : data_start + 2] == LINE_END:
                return bytes(body), data_start + 2
            trailer_end = buffer.find(HEADER_END, data_start)
            if trailer_end < 0:
                return None
            return bytes(body), trailer_end + 4
        data_end = data_start + size
        if len(buffer) < data_end + 2:
            return None
        if buffer[data_end : data_end + 2] != LINE_END:
            raise MalformedResponse("a chunk does not end with CRLF")
        body += buffer[data_start:data_end]
        position = data_end + 2


def parse_response(buffer: bytearray, peer_closed: bool) -> ParsedResponse | None:
    header_end = buffer.find(HEADER_END)
    if header_end < 0:
        if peer_closed:
            raise MalformedResponse("the engine closed the connection before the response headers ended")
        return None
    lines = bytes(buffer[:header_end]).split(LINE_END)
    status_line = lines[0].split(b" ", 2)
    if len(status_line) < 2 or not status_line[0].startswith(b"HTTP/1."):
        raise MalformedResponse(f"bad status line {lines[0][:80]!r}")
    try:
        status = int(status_line[1])
    except ValueError as exc:
        raise MalformedResponse(f"bad status code {status_line[1]!r}") from exc
    length: int | None = None
    chunked = False
    close = status_line[0] == b"HTTP/1.0"
    for line in lines[1:]:
        name, _, value = line.partition(b":")
        lowered = name.strip().lower()
        if lowered == b"content-length":
            try:
                length = int(value.strip())
            except ValueError as exc:
                raise MalformedResponse(f"bad content length {value!r}") from exc
        elif lowered == b"transfer-encoding":
            chunked = CHUNKED_TOKEN in value.lower()
        elif lowered == b"connection":
            tokens = value.strip().lower()
            close = CLOSE_TOKEN in tokens
    body_start = header_end + 4
    if chunked:
        decoded = _chunked_body(buffer, body_start)
        if decoded is None:
            if peer_closed:
                raise MalformedResponse("the engine closed the connection inside a chunked body")
            return None
        body, consumed = decoded
        return ParsedResponse(status, body, consumed, close)
    if length is None and status in BODYLESS_STATUSES:
        length = 0
    if length is None:
        if not peer_closed:
            return None
        return ParsedResponse(status, bytes(buffer[body_start:]), len(buffer), True)
    body_end = body_start + length
    if len(buffer) < body_end:
        if peer_closed:
            raise MalformedResponse("the engine closed the connection before the body ended")
        return None
    return ParsedResponse(status, bytes(buffer[body_start:body_end]), body_end, close)


class _Connection:
    __slots__ = ("worker", "sock", "buffer", "outgoing", "item", "started", "busy")

    def __init__(self, worker: int) -> None:
        self.worker = worker
        self.sock: socket.socket | None = None
        self.buffer = bytearray()
        self.outgoing = memoryview(b"")
        self.item = 0
        self.started = 0.0
        self.busy = False


def _closed_by_peer(sock: socket.socket) -> bool:
    try:
        return sock.recv(1, socket.MSG_PEEK) is not None
    except BlockingIOError:
        return False
    except OSError:
        return True


class PreparedLoad:
    def __init__(self, prepared: list[PreparedSearch], offset: int, connections: int) -> None:
        if not prepared:
            raise ValueError("a prepared load needs at least one request")
        origins = {(item.host, item.port) for item in prepared}
        if len(origins) != 1:
            raise ValueError(f"a prepared load sends to one engine, got {sorted(origins)}")
        self._prepared = prepared
        self._wire = [request_bytes(item) for item in prepared]
        self._host, self._port = next(iter(origins))
        self._selector = selectors.DefaultSelector()
        count = len(prepared)
        self._connections = [_Connection(worker) for worker in range(connections)]
        for connection in self._connections:
            connection.item = (offset + connection.worker) % count

    def _open(self, connection: _Connection) -> None:
        sock = socket.create_connection((self._host, self._port), timeout=REQUEST_TIMEOUT_SECONDS)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.setblocking(False)
        connection.sock = sock
        connection.buffer = bytearray()
        self._selector.register(sock, selectors.EVENT_READ, connection)

    def _drop(self, connection: _Connection) -> None:
        sock = connection.sock
        connection.sock = None
        connection.busy = False
        connection.buffer = bytearray()
        connection.outgoing = memoryview(b"")
        if sock is None:
            return
        try:
            self._selector.unregister(sock)
        except (KeyError, ValueError):
            pass
        sock.close()

    def _ready(self, connection: _Connection) -> socket.socket:
        if connection.sock is not None and _closed_by_peer(connection.sock):
            self._drop(connection)
        if connection.sock is None:
            self._open(connection)
        sock = connection.sock
        if sock is None:
            raise OSError("the load generator could not open a connection to the engine")
        return sock

    def _send_next(self, connection: _Connection) -> None:
        sock = self._ready(connection)
        payload = self._wire[connection.item]
        connection.busy = True
        connection.started = perf_counter()
        try:
            sent = sock.send(payload)
        except BlockingIOError:
            sent = 0
        connection.outgoing = memoryview(payload)[sent:]
        events = selectors.EVENT_READ | selectors.EVENT_WRITE if connection.outgoing else selectors.EVENT_READ
        self._selector.modify(sock, events, connection)

    def _flush(self, connection: _Connection) -> None:
        sock = connection.sock
        if sock is None or not connection.outgoing:
            return
        try:
            sent = sock.send(connection.outgoing)
        except BlockingIOError:
            return
        connection.outgoing = connection.outgoing[sent:]
        if not connection.outgoing:
            self._selector.modify(sock, selectors.EVENT_READ, connection)

    def _receive(self, connection: _Connection) -> ParsedResponse | None:
        sock = connection.sock
        if sock is None:
            raise MalformedResponse("the connection closed before the response arrived")
        try:
            data = sock.recv(RECEIVE_BYTES)
        except BlockingIOError:
            return None
        if data:
            connection.buffer += data
        parsed = parse_response(connection.buffer, peer_closed=not data)
        if parsed is None and not data:
            raise MalformedResponse("the engine closed the connection before responding")
        return parsed

    def _advance(self, connection: _Connection) -> None:
        connection.item += 1
        if connection.item >= len(self._wire):
            connection.item = 0

    def _finish(self, connection: _Connection, parsed: ParsedResponse) -> None:
        connection.busy = False
        del connection.buffer[: parsed.consumed]
        if parsed.close or connection.buffer:
            self._drop(connection)

    def run_window(self, seconds: float, collect: bool, capture_server: bool) -> WindowResult:
        result = WindowResult()
        deadline = perf_counter() + seconds
        drain_until = deadline + REQUEST_TIMEOUT_SECONDS
        for connection in self._connections:
            self._start(connection, result, deadline)
        while any(connection.busy for connection in self._connections):
            now = perf_counter()
            if now > drain_until:
                for connection in self._connections:
                    if connection.busy:
                        self._drop(connection)
                break
            for key, mask in self._selector.select(SELECT_TIMEOUT_SECONDS):
                connection = key.data
                if not connection.busy:
                    if mask & selectors.EVENT_READ:
                        self._drop(connection)
                    continue
                self._service(connection, mask, result, deadline, collect, capture_server)
            if perf_counter() < deadline:
                self._expire(result, deadline)
        return result

    def _start(self, connection: _Connection, result: WindowResult, deadline: float) -> None:
        while perf_counter() < deadline:
            try:
                self._send_next(connection)
                return
            except OSError as exc:
                self._drop(connection)
                result.fail(error_cause("sending the request", exc))
                self._advance(connection)

    def _service(
        self,
        connection: _Connection,
        mask: int,
        result: WindowResult,
        deadline: float,
        collect: bool,
        capture_server: bool,
    ) -> None:
        item = connection.item
        try:
            if mask & selectors.EVENT_WRITE:
                self._flush(connection)
            if not mask & selectors.EVENT_READ:
                return
            parsed = self._receive(connection)
        except (OSError, MalformedResponse) as exc:
            end = perf_counter()
            self._drop(connection)
            self._advance(connection)
            if end <= deadline:
                result.fail(error_cause("receiving the response", exc))
                self._start(connection, result, deadline)
            return
        if parsed is None:
            return
        end = perf_counter()
        started = connection.started
        self._finish(connection, parsed)
        self._advance(connection)
        if end > deadline:
            return
        try:
            response = self._prepared[item].read(parsed.status, parsed.body)
        except Exception as exc:
            result.fail(error_cause("reading the response", exc))
            self._start(connection, result, deadline)
            return
        result.completed += 1
        if collect:
            result.client_ms.append((end - started) * 1000.0)
            elapsed = response.server_elapsed_ms
            if capture_server and isinstance(elapsed, (int, float)) and not isinstance(elapsed, bool):
                result.server_ms.append(float(elapsed))
        self._start(connection, result, deadline)

    def _expire(self, result: WindowResult, deadline: float) -> None:
        now = perf_counter()
        for connection in self._connections:
            if connection.busy and now - connection.started > REQUEST_TIMEOUT_SECONDS:
                self._drop(connection)
                self._advance(connection)
                result.fail(f"waiting for a response: none arrived within {REQUEST_TIMEOUT_SECONDS:g} seconds")
                self._start(connection, result, deadline)

    def close(self) -> None:
        for connection in self._connections:
            self._drop(connection)
        self._selector.close()
