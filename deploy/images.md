# Images

Every image `compose.yaml` runs and the bases of `Dockerfile` and `browser/Dockerfile`, pinned by the digest of its multi-architecture index (amd64 and arm64), so a tag that moves cannot change what starts. `tests/stack.test.sh` checks that every `image:` in the file, but our own, and every `FROM` of `Dockerfile` is pinned and listed here, with the schema engine's pin below. Our own images, `api`, `worker` and `web`, are built from `Dockerfile` by `scripts/images-build.sh` and tagged with their commit (README.md "Images").

| Service | Image | Digest | Pinned |
|---|---|---|---|
| postgres | `pgvector/pgvector:0.8.7-pg18` | `sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11` | 2026-10-21 |
| redis | `redis:8.10.2-alpine` | `sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0` | 2026-10-21 |
| temporal | `temporalio/auto-setup:1.29.7` | `sha256:f14912b699cf73015ad5c4fc18d522d4b014db90e794039214dfb7c022c2644f` | 2026-10-21 |
| temporal-ui | `temporalio/ui:2.56.0` | `sha256:66d55d383bfb334ee0781f21a3b36c865b3f0f2262491a070bb2143394e9fe88` | 2026-10-21 |
| minio | `alpine/minio:RELEASE.2025-10-15T17-29-55Z` | `sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4` | 2026-10-21 |
| mailpit | `axllent/mailpit:v1.31.6` | `sha256:23fe39e81bde596a918000b3135c0f85dc8bb4c9ea6be274b051143f3e300387` | 2026-10-21 |
| otel-lgtm | `grafana/otel-lgtm:0.37.0` | `sha256:57b5ab1ca6619beb180174e2fccce04762470750669d043f544b4726d0582d07` | 2026-10-21 |
| caddy | `caddy:2.11.7-alpine` | `sha256:24ec7b05bc532c7bb57f727030c5056e257ff7138b4b50460306819ff79362bd` | 2026-10-22 |
| api, worker, web (`Dockerfile`'s base) | `node:26.12.0-trixie-slim` | `sha256:e556a144463cc8dc53afe8de6d2fa0db5c132fd39ffa232c17641bd40df2bf11` | 2026-10-22 |
| browser (`browser/Dockerfile`'s base, at the version of providers' `playwright-core`) | `mcr.microsoft.com/playwright:v1.64.1-noble` | `sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f` | 2026-11-13 |

## Updating one

1. `docker buildx imagetools inspect <image>:<tag>` prints the index digest and the platforms under it. Take the digest of the index, not of one platform's manifest, and check that `linux/amd64` and `linux/arm64` are both there.
2. Change the tag and the digest in `compose.yaml` or `Dockerfile` and in the table above, with the date.
3. `pnpm -F deploy test`, and a changeset `deploy: <service> <tag>`.

## minio

MinIO's community edition is archived (its repository on GitHub, 2026-04) and its own images `minio/minio` and `minio/mc` are gone from Docker Hub and from quay.io (2026-09). `alpine/minio` is the alpine-docker project's build of the last community source release, `RELEASE.2025-10-15T17-29-55Z`; the binary reports its version as `DEVELOPMENT.GOGET`, and no fix will follow. Chosen by the owner on 2026-10-21 as a stopgap, with the replacement an open question of alpha-p0-030; the image ships no `mc`.

## Prisma's schema engine

`prisma migrate deploy`, which the api runs at its start, needs Prisma's native schema engine, which the CLI otherwise downloads on first use. The api's image carries it, fetched once at build time and checked against this pin, the `ARG`s at the top of `Dockerfile`, so a container downloads nothing (`images/schema-engine.ts`; `PRISMA_SCHEMA_ENGINE_BINARY` points Prisma at it); the build's `prisma generate` runs on it too.

| | |
|---|---|
| Prisma | 7.10.0 |
| Engines commit | `0edf323efd1d98336f3f0a68684b56f689b900d3` |
| Platform | `debian-openssl-3.0.x`, linux/amd64 only |
| URL | https://binaries.prisma.sh/all_commits/0edf323efd1d98336f3f0a68684b56f689b900d3/debian-openssl-3.0.x/schema-engine.gz |
| SHA-256 of the download | `b7210b525a6e592c0d5db7e7d48edbc0f334e14e212af7af11c0d4a8de755a31` |
| SHA-256 of the binary | `29557c21d47da6f1695ec1a747cb6c607dade5e44e8b3e4fa687bd4dc226956d` |
| Pinned | 2026-10-22 |

A Prisma update fails the image build until the pin follows it: the new commit is `require("@prisma/engines-version").enginesVersion`; download the file at the URL with the new commit, compare its SHA-256 with the `.gz.sha256` file beside it and with Prisma's own release, unpack it, and put the three values in `Dockerfile` and in this table.
