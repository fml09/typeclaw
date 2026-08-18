#!/usr/bin/env bash

set -euo pipefail

raw="${1:-}"
expected_revision="${2:-}"
if [[ -z "$raw" || ! -f "$raw" ]]; then
  echo "usage: validate-release-image-index.sh <raw-manifest.json> [expected-revision]" >&2
  exit 2
fi

if ! jq -e '
  (
    .mediaType == "application/vnd.oci.image.index.v1+json" or
    .mediaType == "application/vnd.docker.distribution.manifest.list.v2+json"
  ) and
  (
    [.manifests[]? | select(.platform.os == "linux") | "\(.platform.os)/\(.platform.architecture)"]
    | sort
  ) == ["linux/amd64", "linux/arm64"] and
  all(
    .manifests[]?;
    (
      .platform.os == "linux" and
      (.platform.architecture == "amd64" or .platform.architecture == "arm64")
    ) or (
      .platform.os == "unknown" and
      .platform.architecture == "unknown" and
      .annotations["vnd.docker.reference.type"] == "attestation-manifest"
    )
  )
' "$raw" >/dev/null; then
  echo "release image must contain exactly linux/amd64 and linux/arm64 images plus optional BuildKit attestations" >&2
  exit 1
fi

if [[ -n "$expected_revision" ]]; then
  revision="$(jq -r '.annotations["org.opencontainers.image.revision"] // empty' "$raw")"
  if [[ "$revision" != "$expected_revision" ]]; then
    echo "release image source annotation mismatch: ${revision:-<missing>} != ${expected_revision}" >&2
    exit 1
  fi
fi
