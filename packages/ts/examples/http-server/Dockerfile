# Build and run the Narsil HTTP server in a container.
# Build context is the repository root:
#   docker build -f packages/ts/examples/http-server/Dockerfile -t narsil-server .
#   docker run --rm -p 7700:7700 narsil-server
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
WORKDIR /app
RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 && rm -rf /var/lib/apt/lists/* \
    && ln -s "/usr/lib/$(uname -m)-linux-gnu/libjemalloc.so.2" /usr/local/lib/libjemalloc.so.2
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2
COPY --from=build /repo /repo
WORKDIR /repo/packages/ts
ENV NARSIL_HOST=0.0.0.0
ENV NARSIL_PORT=7700
ENV NARSIL_NATIVE_CORE_PATH=/repo/narsil-core.node
# Binding to 0.0.0.0 with no auth is refused unless explicitly allowed. This is
# acceptable only on a trusted private network; set NARSIL_API_KEY to require
# auth, or run behind a proxy that terminates it.
ENV NARSIL_ALLOW_INSECURE=true
ENV NODE_OPTIONS=--max-old-space-size-percentage=75
EXPOSE 7700
CMD ["node", "--experimental-strip-types", "examples/http-server/server.ts"]
