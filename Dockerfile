# syntax=docker/dockerfile:1
FROM node:26-slim AS frontend-build
WORKDIR /src
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./frontend/
RUN npm --workspace @ttrpg-codex/frontend run build

FROM golang:1.27.1-bookworm AS host-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY contracts/ ./contracts/
COPY internal/ ./internal/
COPY sdk/ ./sdk/
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/ \
      ./cmd/codex ./cmd/codex-health ./cmd/codex-addon-inspect \
      ./cmd/codex-convert-v1 ./cmd/codex-maintenance

FROM debian:bookworm-slim
# Go uses the operating system trust store for GitHub package downloads.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Production bind mounts were already owned by UID/GID 1000 for the Node host.
# Keep that durable ownership contract across the runtime replacement.
RUN groupadd --gid 1000 codex \
  && useradd --uid 1000 --gid codex --home-dir /app --no-create-home --shell /usr/sbin/nologin codex
WORKDIR /app
COPY --from=host-build /out/codex /app/codex
COPY --from=host-build /out/codex-health /app/codex-health
COPY --from=host-build /out/codex-addon-inspect /app/codex-addon-inspect
COPY --from=host-build /out/codex-convert-v1 /app/codex-convert-v1
COPY --from=host-build /out/codex-maintenance /app/codex-maintenance
COPY --from=frontend-build /src/frontend/dist /app/frontend
RUN mkdir /app/data && chown -R codex:codex /app

USER codex
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/app/codex-health", "http://127.0.0.1:3000/api/health"]
CMD ["/app/codex", "-listen", "0.0.0.0:3000", "-data-dir", "/app/data", "-web-dir", "/app/frontend"]
