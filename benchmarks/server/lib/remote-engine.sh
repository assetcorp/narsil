#!/usr/bin/env bash

ENGINE_STATS_PORT=9877
ENGINE_STATS_LISTEN_TRIES=50
ENGINE_STATS_PID_FILE='$HOME/.bench-engine-stats.pid'
ENGINE_STATS_LOG_FILE='$HOME/.bench-engine-stats.log'
ENGINE_COMPOSE_PROJECT="${BENCH_ENGINE_COMPOSE_PROJECT:-ir-benchmark-engine}"
ENGINE_REPO="${BENCH_ENGINE_REPO:-$(cd ../.. && pwd)}"
ENGINE_FORWARDED_VARS=(
  BENCH_ENGINE_ADDRESS BENCH_API_KEY BENCH_MEM_CAP BENCH_JVM_HEAP
  BENCH_NARSIL_WORKERS BENCH_NARSIL_PROMOTION_THRESHOLD
  NARSIL_GIT_SHA NARSIL_GIT_DIRTY NARSIL_VERSION NARSIL_RUST_VERSION NARSIL_RUST_GIT_DIRTY
)

engine_remote() { [ -n "${BENCH_ENGINE_HOST:-}" ]; }

quoted() { printf '%q ' "$@"; }

engine_ssh() {
  local -a options=(
    -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
  )
  local key="${BENCH_ENGINE_SSH_KEY:-$HOME/.ssh/bench_engine}"
  [ -f "$key" ] && options+=(-i "$key")
  ssh "${options[@]}" "$BENCH_ENGINE_HOST" "$@" </dev/null
}

check_engine_host() {
  engine_remote || return 0
  if [ -n "${BENCH_ENGINE_CPUS:-}" ]; then
    echo "BENCH_ENGINE_CPUS pins the engine beside the harness; leave it unset when the engine serves from ${BENCH_ENGINE_HOST}" >&2
    return 1
  fi
  if [ -z "${BENCH_ENGINE_ADDRESS:-}" ]; then
    echo "BENCH_ENGINE_HOST needs BENCH_ENGINE_ADDRESS, the engine machine's address that the harness connects to" >&2
    return 1
  fi
  engine_ssh "docker version --format '{{.Server.Version}}' >/dev/null && test -f $(quoted "${ENGINE_REPO}/benchmarks/server/docker-compose.remote-engine.yml")" || {
    echo "cannot run Docker or find the repository at ${ENGINE_REPO} on ${BENCH_ENGINE_HOST}" >&2
    return 1
  }
}

engine_env_args() {
  local name
  for name in "${ENGINE_FORWARDED_VARS[@]}"; do
    [ -n "${!name:-}" ] && quoted "${name}=${!name}"
  done
}

engine_compose() {
  if ! engine_remote; then
    docker compose "$@"
    return
  fi
  engine_ssh "cd $(quoted "${ENGINE_REPO}/benchmarks/server") && env $(engine_env_args)docker compose -p $(quoted "$ENGINE_COMPOSE_PROJECT") -f docker-compose.yml -f docker-compose.remote-engine.yml $(quoted "$@")"
}

engine_docker() {
  if engine_remote; then
    engine_ssh "docker $(quoted "$@")"
  else
    docker "$@"
  fi
}

stop_engine_stats() {
  engine_remote || return 0
  engine_ssh "pid=\$(cat ${ENGINE_STATS_PID_FILE} 2>/dev/null) && case \"\$(tr '\\0' ' ' </proc/\$pid/cmdline 2>/dev/null)\" in 'python3 -m ir_bench.engine_stats '*) kill \$pid ;; esac; rm -f ${ENGINE_STATS_PID_FILE}; true" \
    || echo "could not reach ${BENCH_ENGINE_HOST} to stop the engine stats service" >&2
}

start_engine_stats() {
  local container_id="$1" attempt
  stop_engine_stats
  engine_ssh "cd $(quoted "${ENGINE_REPO}/benchmarks/server") || exit 1; PYTHONPATH=src setsid nohup python3 -m ir_bench.engine_stats --host $(quoted "$BENCH_ENGINE_ADDRESS") --port ${ENGINE_STATS_PORT} --container-id $(quoted "$container_id") </dev/null >${ENGINE_STATS_LOG_FILE} 2>&1 & echo \$! >${ENGINE_STATS_PID_FILE}" || return 1
  for ((attempt = 1; attempt <= ENGINE_STATS_LISTEN_TRIES; attempt++)); do
    if timeout 1 bash -c ">/dev/tcp/${BENCH_ENGINE_ADDRESS}/${ENGINE_STATS_PORT}" 2>/dev/null; then
      BENCH_ENGINE_STATS_URL="http://${BENCH_ENGINE_ADDRESS}:${ENGINE_STATS_PORT}"
      return 0
    fi
    sleep 0.2
  done
  echo "the engine stats service never listened on ${BENCH_ENGINE_ADDRESS}:${ENGINE_STATS_PORT}:" >&2
  engine_ssh "tail -n 20 ${ENGINE_STATS_LOG_FILE}" >&2 || true
  return 1
}

harness_engine_args() {
  HARNESS_ENGINE_ARGS=()
  if engine_remote; then
    HARNESS_ENGINE_ARGS=(
      -e BENCH_ENGINE_CONTAINER_ID=
      -e BENCH_ENGINE_ADDRESS="$BENCH_ENGINE_ADDRESS"
      -e BENCH_ENGINE_STATS_URL="$BENCH_ENGINE_STATS_URL"
    )
  else
    HARNESS_ENGINE_ARGS=(-e BENCH_ENGINE_CONTAINER_ID="$1")
  fi
}
