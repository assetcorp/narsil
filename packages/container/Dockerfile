FROM node:24-trixie-slim AS build
WORKDIR /repo
RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile --filter "@delali/narsil-container..." --filter "@delali/narsil-native-build"
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm --filter @delali/narsil run build:code && pnpm --filter @delali/narsil run build:types
RUN pnpm --filter @delali/narsil-embeddings-transformers run build && pnpm --filter @delali/narsil-container run build
RUN pnpm --filter @delali/narsil-native-build run build
RUN pnpm --filter @delali/narsil-container deploy --prod --legacy --config.auto-install-peers=false --config.allow-unused-patches=true /app
RUN arch="$(node -p process.arch)" \
    && abi="$(node -p process.versions.modules)" \
    && core="/app/node_modules/@delali/narsil-native-linux-${arch}" \
    && mkdir -p "${core}" \
    && cp "packages/native/npm/linux-${arch}/package.json" "packages/native/npm/linux-${arch}/narsil-core.node" "${core}/" \
    && for platform in /app/node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/*; do \
      if [ "$(basename "${platform}")" != linux ]; then rm -rf "${platform}"; fi; \
    done \
    && for build in /app/node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/linux/*; do \
      if [ "$(basename "${build}")" != "${arch}" ]; then rm -rf "${build}"; fi; \
    done \
    && find /app/node_modules/.pnpm -name 'uws_*.node' ! -name "uws_linux_${arch}_${abi}.node" -delete \
    && node -e "require('/app/node_modules/uWebSockets.js')"

FROM node:24-trixie-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/assetcorp/narsil" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.description="Narsil search engine, serving one node over HTTP"
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 && rm -rf /var/lib/apt/lists/* \
    && ln -s "/usr/lib/$(uname -m)-linux-gnu/libjemalloc.so.2" /usr/local/lib/libjemalloc.so.2
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size-percentage=75
ARG NARSIL_BUILD_VERSION=0.0.0-dev
ARG NARSIL_BUILD_GIT_SHA=unknown
ENV NARSIL_BUILD_VERSION=${NARSIL_BUILD_VERSION}
ENV NARSIL_BUILD_GIT_SHA=${NARSIL_BUILD_GIT_SHA}
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
WORKDIR /app
EXPOSE 7700
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/dist/main.mjs"]
