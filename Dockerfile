# syntax=docker/dockerfile:1.12
FROM node:26.9-alpine3.23 AS viewer-build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/client/package.json packages/client/package.json
COPY packages/viewer/package.json packages/viewer/package.json
RUN npm ci
COPY packages/viewer/ packages/viewer/
RUN npm run build --workspace @narumitw/morsel-viewer

FROM golang:1.27.1-alpine3.23 AS api-build
WORKDIR /src/api
COPY api/go.mod api/go.sum ./
RUN go mod download
COPY api/ ./
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server && \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=api-build --chown=65532:65532 /out/server /usr/local/bin/server
COPY --from=api-build --chown=65532:65532 /out/migrate /usr/local/bin/migrate
COPY --from=viewer-build --chown=65532:65532 /src/packages/viewer/dist /srv/viewer
ENV MORSEL_VIEWER_DIR=/srv/viewer
USER 65532:65532
EXPOSE 12647
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/usr/local/bin/server", "-healthcheck"]
ENTRYPOINT ["/usr/local/bin/server"]
