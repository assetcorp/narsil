# The harness runs the same way on x86_64 and arm64. trec_eval (pytrec_eval)
# publishes no Linux arm64 wheel, so the builder stage compiles a local
# wheelhouse with a toolchain the slim runtime never needs.
FROM python:3.12-bookworm AS builder
WORKDIR /build
COPY requirements.txt ./
RUN pip wheel --no-cache-dir --wheel-dir=/wheels -r requirements.txt

FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/src \
    IR_DATASETS_HOME=/data/ir_datasets \
    HF_HOME=/opt/hf \
    BENCH_EMBEDDINGS_DIR=/data/embeddings

WORKDIR /app

# libgomp1 is the OpenMP runtime onnxruntime links against; without it fastembed
# fails to import in the slim image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /wheels /wheels
COPY requirements.txt ./
RUN pip install --no-index --find-links=/wheels -r requirements.txt && rm -rf /wheels

# Bake the embedding models into the image so a run downloads no model weights and
# every machine embeds with byte-identical artifacts. After this the harness reads
# only baked models, so HF hub access is disabled at runtime.
RUN python -c "from fastembed import TextEmbedding, SparseTextEmbedding; \
TextEmbedding('sentence-transformers/all-MiniLM-L6-v2'); \
SparseTextEmbedding('Qdrant/bm25')"
ENV HF_HUB_OFFLINE=1

COPY src ./src
COPY config ./config

ENTRYPOINT ["python", "-m", "ir_bench.cli"]
CMD ["--config", "config/benchmark.toml"]
