import json
import struct
import sys
import time
from pathlib import Path

import numpy as np


def main():
    if len(sys.argv) < 2:
        print("Usage: python generate-vectors.py <movies-json-path> [--max N]")
        print("  Generates 1536-dim embeddings and 3D UMAP coordinates.")
        print("  Example: python generate-vectors.py data/processed/tmdb/movies-50000.json")
        sys.exit(1)

    input_path = Path(sys.argv[1])
    max_docs = None
    if "--max" in sys.argv:
        idx = sys.argv.index("--max")
        max_docs = int(sys.argv[idx + 1])

    print(f"Loading {input_path}...")
    with open(input_path) as f:
        movies = json.load(f)

    if max_docs:
        movies = movies[:max_docs]

    print(f"  {len(movies)} movies loaded")

    texts = []
    for m in movies:
        title = m.get("title", "")
        overview = m.get("overview", "")
        tagline = m.get("tagline", "")
        parts = [title]
        if tagline:
            parts.append(tagline)
        parts.append(overview)
        texts.append(". ".join(parts))

    print("Loading embedding model (Alibaba-NLP/gte-Qwen2-1.5B-instruct)...")
    print("  This will download ~3GB on first run.")
    t0 = time.time()

    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(
        "Alibaba-NLP/gte-Qwen2-1.5B-instruct",
        trust_remote_code=False,
        device="mps",
    )

    print(f"  Model loaded in {time.time() - t0:.1f}s")
    print(f"  Embedding dimension: {model.get_sentence_embedding_dimension()}")

    print(f"\nGenerating embeddings for {len(texts)} documents...")
    t0 = time.time()
    embeddings = model.encode(
        texts,
        batch_size=32,
        show_progress_bar=True,
        normalize_embeddings=True,
    )
    elapsed = time.time() - t0
    print(f"  {len(texts)} embeddings generated in {elapsed:.1f}s ({len(texts)/elapsed:.0f} docs/sec)")
    print(f"  Shape: {embeddings.shape}")

    print("\nRunning UMAP dimensionality reduction (1536 -> 3D)...")
    t0 = time.time()

    import umap

    reducer = umap.UMAP(n_components=3, n_neighbors=15, min_dist=0.1, metric="cosine", random_state=42)
    coords_3d = reducer.fit_transform(embeddings)
    print(f"  UMAP completed in {time.time() - t0:.1f}s")
    print(f"  3D coordinates shape: {coords_3d.shape}")

    output_dir = input_path.parent
    stem = input_path.stem

    vectors_path = output_dir / f"{stem}-vectors-1536.bin"
    with open(vectors_path, "wb") as f:
        header = struct.pack("<II", len(movies), 1536)
        f.write(header)
        for vec in embeddings:
            f.write(struct.pack(f"<{1536}f", *vec.tolist()))

    vectors_size_mb = vectors_path.stat().st_size / 1024 / 1024
    print(f"\nVectors written: {vectors_path} ({vectors_size_mb:.1f} MB)")

    coords_path = output_dir / f"{stem}-umap-3d.bin"
    with open(coords_path, "wb") as f:
        header = struct.pack("<II", len(movies), 3)
        f.write(header)
        for coord in coords_3d:
            f.write(struct.pack("<3f", *coord.tolist()))

    coords_size_mb = coords_path.stat().st_size / 1024 / 1024
    print(f"UMAP 3D written: {coords_path} ({coords_size_mb:.1f} MB)")

    ids_path = output_dir / f"{stem}-vector-ids.json"
    ids = [m["id"] for m in movies]
    with open(ids_path, "w") as f:
        json.dump(ids, f)
    print(f"Vector IDs written: {ids_path}")

    print("\nVerification:")
    with open(vectors_path, "rb") as f:
        n, d = struct.unpack("<II", f.read(8))
        print(f"  vectors: {n} documents x {d} dimensions")
        first_vec = struct.unpack(f"<{d}f", f.read(d * 4))
        norm = sum(x * x for x in first_vec) ** 0.5
        print(f"  first vector L2 norm: {norm:.4f} (should be ~1.0 for normalized)")

    with open(coords_path, "rb") as f:
        n, d = struct.unpack("<II", f.read(8))
        print(f"  UMAP: {n} points x {d} dimensions")

    print("\nDone.")


if __name__ == "__main__":
    main()
