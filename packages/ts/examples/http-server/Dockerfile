# Build and run the Narsil HTTP server in a container.
# Build context is the repository root:
#   docker build -f packages/ts/examples/http-server/Dockerfile -t narsil-server .
#   docker run --rm -p 7700:7700 narsil-server
FROM node:22-trixie-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @delali/narsil build

FROM node:22-trixie-slim AS runtime
WORKDIR /app
RUN corepack enable
COPY --from=build /repo /repo
WORKDIR /repo/packages/ts
ENV NARSIL_HOST=0.0.0.0
ENV NARSIL_PORT=7700
# Binding to 0.0.0.0 with no auth is refused unless explicitly allowed. This is
# acceptable only on a trusted private network; set NARSIL_API_KEY to require
# auth, or run behind a proxy that terminates it.
ENV NARSIL_ALLOW_INSECURE=true
EXPOSE 7700
CMD ["node", "--experimental-strip-types", "examples/http-server/server.ts"]
