FROM rust:1.99.1-slim-trixie AS build
WORKDIR /repo
COPY packages/rust packages/rust
COPY packages/native/include packages/native/include
COPY packages/native/src packages/native/src
COPY packages/rust-server packages/rust-server
COPY packages/rust-container packages/rust-container
WORKDIR /repo/packages/rust-container
RUN cargo build --release --locked --bin narsil-container && cp target/release/narsil-container /narsil-container

FROM debian:trixie-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/assetcorp/narsil" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.description="Narsil search engine, serving one node over HTTP from the Rust server"
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 && rm -rf /var/lib/apt/lists/* \
    && ln -s "/usr/lib/$(uname -m)-linux-gnu/libjemalloc.so.2" /usr/local/lib/libjemalloc.so.2 \
    && groupadd --gid 1000 narsil \
    && useradd --uid 1000 --gid narsil --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin narsil \
    && mkdir -p /data && chown narsil:narsil /data
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2
ARG NARSIL_BUILD_VERSION=0.0.0-dev
ARG NARSIL_BUILD_GIT_SHA=unknown
ENV NARSIL_BUILD_VERSION=${NARSIL_BUILD_VERSION}
ENV NARSIL_BUILD_GIT_SHA=${NARSIL_BUILD_GIT_SHA}
COPY --from=build /narsil-container /usr/local/bin/narsil-container
VOLUME /data
USER narsil
EXPOSE 7700
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/narsil-container"]
