#!/usr/bin/env bash
# images:build (README.md "Images"): builds the images of our own apps from deploy/Dockerfile, one
# target each, and tags them with the commit: `<registry>/api:<12-character commit>`. The pipeline's
# hand-triggered job `images:build` is to run it; a laptop runs it as it is.
#   images-build.sh [--tag <tag>] [--push]
# IMAGE_REGISTRY prefixes the names, localhost/whytide by default, which no registry serves, so an
# image never comes from Docker Hub by mistake. A tree with changes not committed is refused unless
# --tag names the tag, so that a commit's tag always holds that commit's code. --push pushes the tags.
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

usage() { echo "usage: images-build.sh [--tag <tag>] [--push]" >&2; exit 2; }
fail() { printf 'images-build: %s\n' "$*" >&2; exit 1; }

registry="${IMAGE_REGISTRY:-localhost/whytide}"
tag=""
push=false
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) [ $# -ge 2 ] || usage; tag="$2"; shift 2 ;;
    --push) push=true; shift ;;
    *) usage ;;
  esac
done
if [ -z "$tag" ]; then
  [ -z "$(git status --porcelain)" ] || fail "the tree has changes not committed: commit them, or name a tag with --tag"
  tag="$(git rev-parse --short=12 HEAD)"
fi
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail "not an image tag: $tag"

revision="$(git rev-parse HEAD)"
for target in api worker web; do
  docker build --file deploy/Dockerfile --target "$target" \
    --label "org.opencontainers.image.revision=$revision" --tag "$registry/$target:$tag" .
done
if [ "$push" = true ]; then
  for target in api worker web; do docker push "$registry/$target:$tag"; done
fi
echo "IMAGE_TAG=$tag"
