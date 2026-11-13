from __future__ import annotations

import os
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest


class Probe:
    def __init__(self, directory: Path, **settings: str) -> None:
        binary = os.environ.get("NARSIL_RUST_PROBE_BINARY")
        if not binary:
            pytest.skip("set NARSIL_RUST_PROBE_BINARY to a release build of the probe")
        self.binary = binary
        self.directory = directory
        self.settings = settings
        self.process = None
        self.client = None
        self.output = None

    def start(self) -> Probe:
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        assert port not in (17700, 17701)
        env = {
            **os.environ,
            "NARSIL_HOST": "127.0.0.1",
            "NARSIL_PORT": str(port),
            "NARSIL_HTTP_THREADS": "2",
            "NARSIL_SEARCH_THREADS": "2",
            "NARSIL_MAX_BODY_BYTES": "65536",
            "NARSIL_MAX_IMPORT_BYTES": "8388608",
            "NARSIL_DURABILITY_DIR": str(self.directory / "data"),
            **self.settings,
        }
        self.output = (self.directory / "server.log").open("ab")
        self.process = subprocess.Popen([self.binary], env=env, stdout=self.output, stderr=self.output)
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=30)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            assert self.process.poll() is None, (self.directory / "server.log").read_text()
            try:
                if self.client.get("/readyz").status_code == 200:
                    return self
            except httpx.TransportError:
                pass
            time.sleep(0.01)
        raise AssertionError("probe did not become ready")

    def stop(self, kill: bool = False) -> None:
        if self.process is not None and self.process.poll() is None:
            if kill:
                self.process.kill()
            else:
                self.process.terminate()
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
                raise
        if self.client is not None:
            self.client.close()
        if self.output is not None:
            self.output.close()

    def create(self, name: str = "documents", vectors: bool = False, **extra: object) -> None:
        schema = {"text": "string"}
        config = {"schema": schema, **extra}
        if vectors:
            schema["embedding"] = "vector[16]"
            config["vectorPromotion"] = {"threshold": 1000000, "quantization": "none"}
        response = self.client.post("/indexes", json={"name": name, "config": config})
        assert response.status_code == 201, response.text

    def task(self, task_id: str) -> dict:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            response = self.client.get(f"/tasks/{task_id}")
            assert response.status_code == 200, response.text
            record = response.json()
            if record["status"] != "running":
                return record
            time.sleep(0.01)
        raise AssertionError("task did not settle")
