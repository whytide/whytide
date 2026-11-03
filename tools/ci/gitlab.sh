#!/bin/sh
# The GitLab job's shell (.gitlab-ci.yml), POSIX sh for the Docker image it runs in. What a laptop
# does happens here the same way: `start` brings up a Docker daemon inside the job, then a Node
# container on the job's network with the checkout mounted at its own path, installs, starts the
# development stack of deploy/compose.yaml on that daemon and creates the job's slice; `step <name>`
# runs `pnpm ci:local <name>` in that container. The stack publishes its ports on the job's localhost,
# as on a laptop, so .env.local and the deploy tests work unchanged. The docker CLI and the Compose
# plugin of the job's image, static binaries, are mounted into the Node container; pnpm comes from
# npm at the version package.json pins.
set -eu

# The job's image points its CLI at tcp://docker:2375, the layout with a dind service container;
# here the daemon is the job's own, on its socket.
export DOCKER_HOST=unix:///var/run/docker.sock
node=whytide-ci-node
# A command `docker exec` starts gets the daemon's umask, 0000 in this job: the folders it made,
# /root/.cache among them, were writable by any user, and @swc/core refuses to load its native addon
# from a cache under such a folder. So every command sets a laptop's umask first.
in_node() { docker exec "$node" sh -c 'umask 022 && exec "$@"' sh "$@"; }

case "${1:-}" in
  start)
    : "${CI_PROJECT_DIR:?}" "${NODE_IMAGE:?}"
    dockerd-entrypoint.sh >/var/log/dockerd.log 2>&1 &
    tries=0
    until docker info >/dev/null 2>&1; do
      tries=$((tries + 1))
      if [ "$tries" -ge 60 ]; then
        cat /var/log/dockerd.log >&2
        echo "gitlab.sh: dockerd did not start" >&2
        exit 1
      fi
      sleep 1
    done
    git config --global --add safe.directory '*'
    # The base of the branch checks; the runner fetched the pipeline's ref only.
    git fetch -q origin main
    # Temporary files under the checkout, which the daemon sees at the same path: the tests' clones
    # run Docker too (the secret scan, the stack).
    mkdir -p "$CI_PROJECT_DIR/.tmp"
    docker run -d --name "$node" --network host \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v /usr/local/bin/docker:/usr/local/bin/docker:ro \
      -v /usr/local/libexec/docker/cli-plugins:/usr/local/libexec/docker/cli-plugins:ro \
      -v "$CI_PROJECT_DIR:$CI_PROJECT_DIR" -w "$CI_PROJECT_DIR" \
      -e CI=true -e "CI_MERGE_REQUEST_LABELS=${CI_MERGE_REQUEST_LABELS:-}" \
      -e "pnpm_config_store_dir=$CI_PROJECT_DIR/.pnpm-store" \
      -e "TMPDIR=$CI_PROJECT_DIR/.tmp" \
      "$NODE_IMAGE" sleep infinity >/dev/null
    in_node git config --global --add safe.directory '*'
    in_node sh -c 'npm install -g --no-fund --no-audit "$(node -p "require(\"./package.json\").packageManager")"'
    in_node pnpm install --frozen-lockfile
    in_node pnpm stack:up
    in_node pnpm env:create pipeline
    ;;
  step)
    shift
    [ $# -gt 0 ] || { echo "gitlab.sh: step needs a name" >&2; exit 2; }
    in_node pnpm ci:local "$@"
    ;;
  *)
    echo "usage: gitlab.sh start | step <name>..." >&2
    exit 2
    ;;
esac
