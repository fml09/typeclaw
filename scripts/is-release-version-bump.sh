#!/usr/bin/env bash

set -euo pipefail

parent="${1:-}"
commit="${2:-}"
version="${3:-}"
if [[ -z "$parent" || -z "$commit" || -z "$version" ]]; then
  echo "usage: is-release-version-bump.sh <parent> <commit> <x.y.z>" >&2
  exit 2
fi

# Callers intentionally pass both symbolic revisions (for example HEAD^) and
# object IDs recovered from npm/OCI metadata. Normalize both before comparing
# parent identity so the exact same commit is not rejected solely because the
# inputs use different Git spellings.
parent="$(git rev-parse --verify "${parent}^{commit}")"
commit="$(git rev-parse --verify "${commit}^{commit}")"

read -r -a parents <<<"$(git show -s --format=%P "$commit")"
[[ "${#parents[@]}" -eq 1 && "${parents[0]}" == "$parent" ]] || exit 1
[[ "$(git diff --name-only "$parent" "$commit")" == 'package.json' ]] || exit 1
[[ "$(git show "${commit}:package.json" | jq -r '.version')" == "$version" ]] || exit 1
[[ "$(git show -s --format=%s "$commit")" == "$version" ]] || exit 1

# `npm version --no-git-tag-version` may change only package.json#version.
# Any other package metadata delta would make the source tarball and the
# canonical parent checkout publish different artifacts under one source SHA.
cmp -s \
  <(git show "${parent}:package.json" | jq -S 'del(.version)') \
  <(git show "${commit}:package.json" | jq -S 'del(.version)')
