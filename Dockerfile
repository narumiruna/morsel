# syntax=docker/dockerfile:1.12
FROM node:26.8-alpine3.23 AS viewer-build
WORKDIR /src/viewer
COPY viewer/package.json viewer/package-lock.json ./
RUN npm ci
COPY viewer/ ./
RUN npm run build

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
COPY --from=viewer-build --chown=65532:65532 /src/viewer/dist /srv/viewer
ENV MORSEL_VIEWER_DIR=/srv/viewer
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/usr/local/bin/server", "-healthcheck"]
ENTRYPOINT ["/usr/local/bin/server"]
