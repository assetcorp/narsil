from __future__ import annotations

import http.client
import json
import os
import queue
import shutil
import signal
import socket
import subprocess
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

REPOSITORY = Path(__file__).resolve().parents[3]
LAUNCHER = REPOSITORY / "packages" / "ts" / "scripts" / "client-test-server.mjs"
READY_TIMEOUT_SECONDS = 90.0
STOP_TIMEOUT_SECONDS = 15.0
HTML_PAGE = b"<!doctype html><html><body><h1>502 Bad Gateway</h1></body></html>"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@dataclass
class NodeProcess:
    settings: dict[str, Any]
    process: subprocess.Popen[str] | None = None
    url: str = ""
    output: list[str] = field(default_factory=list)

    def start(self) -> None:
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("The tests need Node.js on the PATH to start a Narsil server")
        environment = {key: value for key, value in os.environ.items() if key != "NODE_OPTIONS"}
        environment["NARSIL_CLIENT_TEST_SERVER"] = json.dumps(self.settings)
        self.process = subprocess.Popen(
            [node, str(LAUNCHER)],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        lines: queue.Queue[str | None] = queue.Queue()
        stream = self.process.stdout
        assert stream is not None

        def pump() -> None:
            for line in stream:
                self.output.append(line)
                lines.put(line)
            lines.put(None)

        threading.Thread(target=pump, daemon=True).start()
        deadline = time.monotonic() + READY_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            try:
                line = lines.get(timeout=max(deadline - time.monotonic(), 0.01))
            except queue.Empty:
                break
            if line is None:
                break
            if line.startswith("READY "):
                self.url = f"http://127.0.0.1:{int(line.split()[1])}"
                return
        self.kill()
        raise RuntimeError("The Narsil server did not start:\n" + "".join(self.output[-80:]))

    def kill(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.kill()
            self.process.wait(STOP_TIMEOUT_SECONDS)

    def stop(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        self.process.send_signal(signal.SIGTERM)
        try:
            self.process.wait(STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            self.kill()


class _ForwardingHandler(BaseHTTPRequestHandler):
    upstream_port = 0

    def _forward(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {key: value for key, value in self.headers.items() if key.lower() not in ("host", "connection")}
        connection = http.client.HTTPConnection("127.0.0.1", self.upstream_port, timeout=10)
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            upstream = connection.getresponse()
            payload = upstream.read()
            self.send_response(upstream.status)
            for key, value in upstream.getheaders():
                if key.lower() not in ("connection", "transfer-encoding", "content-length"):
                    self.send_header(key, value)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except OSError:
            self.send_response(502)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(HTML_PAGE)))
            self.end_headers()
            self.wfile.write(HTML_PAGE)
        finally:
            connection.close()

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _forward

    def log_message(self, format: str, *args: Any) -> None:
        return


DRIP_INTERVAL_SECONDS = 0.05
DRIP_LIMIT_SECONDS = 30.0
DRIP_DECLARED_BYTES = 1_000_000


class _DrippingHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(DRIP_DECLARED_BYTES))
        self.end_headers()
        self.wfile.flush()
        stops_at = time.monotonic() + DRIP_LIMIT_SECONDS
        try:
            while time.monotonic() < stops_at:
                self.wfile.write(b" ")
                self.wfile.flush()
                time.sleep(DRIP_INTERVAL_SECONDS)
        except OSError:
            return

    def log_message(self, format: str, *args: Any) -> None:
        return


class DrippingServer:
    def __init__(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _DrippingHandler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class ForwardingProxy:
    def __init__(self, upstream_port: int) -> None:
        handler = type("Handler", (_ForwardingHandler,), {"upstream_port": upstream_port})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
