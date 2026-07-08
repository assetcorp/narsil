import os
import struct
import sys
import time
from pathlib import Path

import numpy as np


def parse_header(f, path):
    header = f.read(8)
    if len(header) != 8:
        raise ValueError(f"{path}: file is shorter than the 8-byte header")
    count, dims = struct.unpack("<II", header)
    if count == 0 or dims == 0:
        raise ValueError(f"{path}: header reports count={count} dims={dims}")
    expected = 8 + count * dims * 4
    actual = path.stat().st_size
    if actual != expected:
        raise ValueError(
            f"{path}: size {actual} does not match header ({count} x {dims} float32 -> {expected}); "
            "the file is truncated or does not use the <II> count/dims layout"
        )
    return count, dims


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print("Usage: python project-vectors.py <vectors-1536-bin> [--out <umap-3d-bin>]")
        print()
        print("  Reduces a committed/release 1536-dim vectors binary to a 3D UMAP")
        print("  projection for the browser example's Vectors tab. Runs on CPU and")
        print("  needs no embedding model or GPU. Requires: numpy, umap-learn.")
        print()
        print("  The published vectors binary lives as a release asset, for example:")
        print("  https://github.com/assetcorp/narsil/releases/download/data-v0/movies-10000-vectors-1536.bin")
        sys.exit(0 if len(sys.argv) >= 2 else 1)

    input_path = Path(sys.argv[1])
    if not input_path.is_file():
        print(f"Input not found: {input_path}")
        sys.exit(1)

    out_path = None
    if "--out" in sys.argv:
        out_path = Path(sys.argv[sys.argv.index("--out") + 1])

    with open(input_path, "rb") as f:
        count, dims = parse_header(f, input_path)
        print(f"Reading {count} vectors x {dims} dims from {input_path}")
        vectors = np.fromfile(f, dtype="<f4", count=count * dims).reshape(count, dims)

    if not np.isfinite(vectors).all():
        raise ValueError(f"{input_path}: vectors contain NaN or infinite values")

    if out_path is None:
        name = input_path.name
        suffix = f"-vectors-{dims}.bin"
        base = name[: -len(suffix)] if name.endswith(suffix) else input_path.stem
        out_path = input_path.parent / f"{base}-umap-3d.bin"

    ids_path = out_path.parent / f"{out_path.name[: -len('-umap-3d.bin')]}-vector-ids.json"
    if ids_path.is_file():
        import json

        with open(ids_path) as f:
            id_count = len(json.load(f))
        if id_count != count:
            raise ValueError(
                f"{ids_path} holds {id_count} ids but the vectors binary holds {count}; "
                "the projection would not line up with the committed ids"
            )

    print("Running UMAP (CPU, cosine, 3 components)...")
    t0 = time.time()

    import umap

    reducer = umap.UMAP(n_components=3, n_neighbors=15, min_dist=0.1, metric="cosine", random_state=42)
    coords_3d = reducer.fit_transform(vectors)
    print(f"  UMAP completed in {time.time() - t0:.1f}s -> {coords_3d.shape}")

    coords = np.ascontiguousarray(coords_3d, dtype="<f4")
    tmp_path = out_path.with_name(out_path.name + ".tmp")
    with open(tmp_path, "wb") as f:
        f.write(struct.pack("<II", count, 3))
        coords.tofile(f)
    os.replace(tmp_path, out_path)

    size_kb = out_path.stat().st_size / 1024
    print(f"Wrote {out_path} ({size_kb:.0f} KB)")

    with open(out_path, "rb") as f:
        n, d = struct.unpack("<II", f.read(8))
        print(f"Verification: {n} points x {d} dims")

    print(
        "\nNote: UMAP is not identical across machines even with a fixed random_state, "
        "so this layout will differ from the committed asset while showing the same structure."
    )


if __name__ == "__main__":
    main()
