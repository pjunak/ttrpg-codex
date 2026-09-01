FROM node:26-slim AS frontend-build
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.26-bookworm AS host-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY contracts/ ./contracts/
COPY internal/ ./internal/
COPY sdk/ ./sdk/
RUN CGO_ENABLED=0 go build -trimpath -o /out/codex ./cmd/codex
RUN CGO_ENABLED=0 go build -trimpath -o /out/codex-health ./cmd/codex-health

FROM debian:bookworm-slim
RUN groupadd --system codex && useradd --system --gid codex --home-dir /app codex
WORKDIR /app
COPY --from=host-build /out/codex /app/codex
COPY --from=host-build /out/codex-health /app/codex-health
COPY --from=frontend-build /src/frontend/dist /app/frontend
RUN mkdir /app/data && chown -R codex:codex /app

USER codex
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/app/codex-health", "http://127.0.0.1:3000/api/health"]
CMD ["/app/codex", "-listen", "0.0.0.0:3000", "-data-dir", "/app/data", "-web-dir", "/app/frontend"]
