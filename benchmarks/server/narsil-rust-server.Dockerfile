FROM rust:1.99.1-slim-trixie AS build
WORKDIR /repo
COPY packages/rust packages/rust
COPY packages/native/include packages/native/include
COPY packages/native/src packages/native/src
COPY packages/rust-server packages/rust-server
WORKDIR /repo/packages/rust-server
RUN cargo build --release --locked --bin narsil-server && cp target/release/narsil-server /narsil-server

FROM debian:trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 && rm -rf /var/lib/apt/lists/* \
    && ln -s "/usr/lib/$(uname -m)-linux-gnu/libjemalloc.so.2" /usr/local/lib/libjemalloc.so.2
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2
COPY --from=build /narsil-server /usr/local/bin/narsil-server
ARG NARSIL_GIT_SHA=
ARG NARSIL_GIT_DIRTY=true
ARG NARSIL_VERSION=
ENV NARSIL_BUILD_GIT_SHA=${NARSIL_GIT_SHA} \
    NARSIL_BUILD_DIRTY=${NARSIL_GIT_DIRTY} \
    NARSIL_BUILD_VERSION=${NARSIL_VERSION}
EXPOSE 7700
CMD ["/usr/local/bin/narsil-server"]
