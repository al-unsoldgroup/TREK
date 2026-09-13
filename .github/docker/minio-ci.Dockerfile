# Ephemeral, loopback-only S3 contract fixture. No production data or license.
# Pinned community security release: https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z
FROM golang:1.25 AS build
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/minio/minio@RELEASE.2025-10-15T17-29-55Z

FROM debian:trixie-slim
COPY --from=build /out/minio /minio
ENTRYPOINT ["/minio"]
