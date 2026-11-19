#!/usr/bin/env bash

RESULT_RUNS_PATHSPEC=(
  ':(exclude)benchmarks/in-process/results/runs'
  ':(exclude)benchmarks/server/results/runs'
  ':(exclude)benchmarks/engine-languages/results/runs'
)

github_clone_url() {
  case "$1" in
    https://github.com/*) printf '%s\n' "$1" ;;
    git@github.com:*) printf 'https://github.com/%s\n' "${1#git@github.com:}" ;;
    ssh://git@github.com/*) printf 'https://github.com/%s\n' "${1#ssh://git@github.com/}" ;;
    *) return 1 ;;
  esac
}

published_checkout() {
  local origin url sha branch changes
  changes="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal -- . "${RESULT_RUNS_PATHSPEC[@]}")" || return 1
  [ -z "$changes" ] || return 1
  origin="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null)" || return 1
  url="$(github_clone_url "$origin")" || return 1
  sha="$(git -C "$REPO_ROOT" rev-parse HEAD)" || return 1
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)" || return 1
  git -C "$REPO_ROOT" fetch --quiet origin || return 1
  [ -n "$(git -C "$REPO_ROOT" branch -r --contains "$sha" 2>/dev/null)" ] || return 1
  printf '%s %s %s\n' "$url" "$sha" "$branch"
}

sync_clone() {
  local url="$1" sha="$2" branch="$3" place
  if [ "$branch" = "HEAD" ]; then
    place="git -C narsil checkout --quiet --detach $sha"
  else
    place="git -C narsil checkout --quiet -B $(printf '%q' "$branch") $sha"
  fi
  prov_ssh "set -e; sudo rm -rf narsil; git clone --quiet --filter=blob:none --no-checkout $(printf '%q' "$url") narsil; $place; test \"\$(git -C narsil rev-parse HEAD)\" = $sha; test -z \"\$(git -C narsil status --porcelain)\""
}
