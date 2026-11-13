from __future__ import annotations

import argparse
import http.server
import json
import sys
from pathlib import Path

from .core.cgroup_files import ENGINE_MACHINE_PATH, ENGINE_STATS_FILES
from .core.engine_cpu import locate_engine_cgroup
from .core.host_info import describe_machine

DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup"
LISTEN_BACKLOG = 256


class EngineStatsServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = LISTEN_BACKLOG


def _handler(cgroup_dir: Path, machine_body: bytes) -> type[http.server.BaseHTTPRequestHandler]:
    class EngineStatsHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            name = self.path.lstrip("/")
            if name == ENGINE_MACHINE_PATH:
                self._reply(machine_body, "application/json")
                return
            if name not in ENGINE_STATS_FILES:
                self.send_error(404)
                return
            try:
                body = (cgroup_dir / name).read_bytes()
            except OSError:
                self.send_error(503)
                return
            self._reply(body, "text/plain")

        def _reply(self, body: bytes, content_type: str) -> None:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            return

    return EngineStatsHandler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Serve one engine container's cgroup CPU and memory files to a harness on another machine."
    )
    parser.add_argument("--host", required=True, help="address to listen on, the engine machine's private address")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--container-id", required=True)
    parser.add_argument("--cgroup-root", type=Path, default=Path(DEFAULT_CGROUP_ROOT))
    args = parser.parse_args(argv)

    cgroup_dir = locate_engine_cgroup(args.cgroup_root, args.container_id)
    if cgroup_dir is None:
        print(f"no cgroup under {args.cgroup_root} holds container {args.container_id}", file=sys.stderr, flush=True)
        return 1
    machine_body = json.dumps(describe_machine()).encode("utf-8")
    server = EngineStatsServer((args.host, args.port), _handler(cgroup_dir, machine_body))
    print(f"serving {cgroup_dir} on {args.host}:{args.port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
