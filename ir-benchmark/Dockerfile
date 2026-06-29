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
    IR_DATASETS_HOME=/data/ir_datasets

WORKDIR /app

COPY --from=builder /wheels /wheels
COPY requirements.txt ./
RUN pip install --no-index --find-links=/wheels -r requirements.txt && rm -rf /wheels

COPY src ./src
COPY config ./config

ENTRYPOINT ["python", "-m", "ir_bench.cli"]
CMD ["--config", "config/benchmark.toml"]
