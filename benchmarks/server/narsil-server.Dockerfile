# Narsil HTTP server image for the benchmark.
#
# The repo's example image (packages/ts/examples/http-server/Dockerfile) is built
# on Debian bookworm (glibc 2.36). The uWebSockets.js arm64 prebuilt the server
# loads requires glibc 2.38, so that image fails to start on arm64 hosts such as
# Apple Silicon. Trixie (glibc 2.41) satisfies it on both architectures.
FROM node:24-trixie-slim AS build
WORKDIR /repo
RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile --filter "@delali/narsil..." --filter "@delali/narsil-native-build"
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm --filter @delali/narsil build
RUN pnpm --filter @delali/narsil-native-build build && cp packages/native/npm/linux-*/narsil-core.node /repo/narsil-core.node

FROM node:24-trixie-slim AS runtime
WORKDIR /repo
RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 && rm -rf /var/lib/apt/lists/* \
    && ln -s "/usr/lib/$(uname -m)-linux-gnu/libjemalloc.so.2" /usr/local/lib/libjemalloc.so.2
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2
COPY --from=build /repo /repo
WORKDIR /repo/packages/ts
# Narsil is the one engine built from source here, so the source commit is stamped
# into the image at build time, the way the vendored engine images already carry
# their vendors' build hashes. The benchmark then reads every engine's build
# identity the same way, from its own /version-style endpoint. The build args are
# supplied by the orchestrator from the host's git checkout; the .git directory is
# excluded from the build context, so the commit cannot be read inside the image.
ARG NARSIL_GIT_SHA=
ARG NARSIL_GIT_DIRTY=false
ARG NARSIL_VERSION=
ENV NARSIL_NATIVE_CORE_PATH=/repo/narsil-core.node \
    NARSIL_REQUIRE_NATIVE_CORE=1
ENV NARSIL_BUILD_GIT_SHA=${NARSIL_GIT_SHA} \
    NARSIL_BUILD_DIRTY=${NARSIL_GIT_DIRTY} \
    NARSIL_BUILD_VERSION=${NARSIL_VERSION}
EXPOSE 7700
CMD ["node", "--experimental-strip-types", "examples/http-server/server.ts"]
