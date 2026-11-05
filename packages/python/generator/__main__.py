from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from generator.ir import SpecError, build_api
from generator.python_models import render_models
from generator.python_operations import ASYNC, SYNC, render_operations

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
SPEC_PATH = PACKAGE_ROOT.parent / "ts" / "openapi.json"
SOURCE_ROOT = PACKAGE_ROOT / "src" / "narsil_client"
GENERATED_DIRECTORIES = ("models", SYNC.package, ASYNC.package)


def render(spec_path: Path) -> dict[str, dict[str, str]]:
    api = build_api(json.loads(spec_path.read_text(encoding="utf-8")))
    return {
        "models": render_models(api),
        SYNC.package: render_operations(api, SYNC),
        ASYNC.package: render_operations(api, ASYNC),
    }


def format_tree(root: Path) -> None:
    config = str(PACKAGE_ROOT / "pyproject.toml")
    for command in (["check", "--fix", "--select", "I", "--quiet"], ["format", "--quiet"]):
        subprocess.run([sys.executable, "-m", "ruff", *command, "--config", config, str(root)], check=True)


def generate(spec_path: Path) -> dict[str, dict[str, str]]:
    rendered = render(spec_path)
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        for directory, files in rendered.items():
            (root / directory).mkdir()
            for name, text in files.items():
                (root / directory / name).write_text(text, encoding="utf-8")
        format_tree(root)
        return {
            directory: {path.name: path.read_text(encoding="utf-8") for path in sorted((root / directory).iterdir())}
            for directory in rendered
        }


def committed(directory: Path) -> dict[str, str]:
    if not directory.is_dir():
        return {}
    return {path.name: path.read_text(encoding="utf-8") for path in sorted(directory.glob("*.py"))}


def stale_files(generated: dict[str, dict[str, str]]) -> list[str]:
    stale: list[str] = []
    for directory, files in generated.items():
        current = committed(SOURCE_ROOT / directory)
        stale.extend(
            f"src/narsil_client/{directory}/{name}"
            for name in sorted(set(files) | set(current))
            if files.get(name) != current.get(name)
        )
    return stale


def write(generated: dict[str, dict[str, str]]) -> None:
    for directory, files in generated.items():
        target = SOURCE_ROOT / directory
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True)
        for name, text in files.items():
            (target / name).write_text(text, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the Narsil Python client from the OpenAPI file.")
    parser.add_argument("--write", action="store_true", help="replace the committed code with fresh output")
    parser.add_argument("--spec", type=Path, default=SPEC_PATH, help="the OpenAPI file to read")
    arguments = parser.parse_args()
    try:
        generated = generate(arguments.spec)
    except SpecError as error:
        print(f"The generator stopped: {error}", file=sys.stderr)
        return 1
    if arguments.write:
        write(generated)
        return 0
    stale = stale_files(generated)
    if stale:
        print(
            "The committed client differs from fresh output, so regenerate it with the generate:write target.",
            file=sys.stderr,
        )
        for path in stale:
            print(f"  {path}", file=sys.stderr)
        return 1
    print("The committed client matches the OpenAPI file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
