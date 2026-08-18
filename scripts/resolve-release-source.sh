#!/usr/bin/env bash

set -euo pipefail

version="${1:-}"
head_ref="${2:-HEAD}"
if [[ -z "$version" ]]; then
  echo "usage: resolve-release-source.sh <x.y.z> [head]" >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
head_commit="$(git rev-parse --verify "${head_ref}^{commit}")"
matches=()

# A completed reservation is an exact package.json version-only commit on
# main's first-parent history. Later PRs may be merged on top before a partial
# release is repaired, so looking only at HEAD (or HEAD^) is insufficient.
# Resolve the unique reservation back to its source parent. Multiple matching
# reservations for one version are an integrity violation and fail closed.
while IFS=$'\t' read -r candidate subject; do
  [[ "$subject" == "$version" ]] || continue
  parent="$(git rev-parse --verify "${candidate}^1")"
  if bash "${script_dir}/is-release-version-bump.sh" "$parent" "$candidate" "$version"; then
    matches+=("${parent}:${candidate}")
  fi
done < <(git log --first-parent --format='%H%x09%s' "$head_commit")

case "${#matches[@]}" in
  0)
    printf '%s\n' "$head_commit"
    ;;
  1)
    printf '%s\n' "${matches[0]%%:*}"
    ;;
  *)
    echo "multiple exact release reservations found for ${version}" >&2
    exit 1
    ;;
esac
