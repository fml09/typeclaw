#!/usr/bin/env bash

set -euo pipefail

image="${1:-}"
if [[ -z "$image" ]]; then
  echo "usage: smoke-managed-runtime-image.sh <image-ref>" >&2
  exit 2
fi

container_name="typeclaw-managed-smoke-$$-${RANDOM}"
agent_volume="${container_name}-agent"
home_volume="${container_name}-home"
control_volume="${container_name}-control"
started=0

cleanup() {
  if [[ "$started" == "1" ]]; then
    docker rm -f "$container_name" >/dev/null 2>&1 || true
  fi
  docker volume rm "$agent_volume" "$home_volume" "$control_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$agent_volume" >/dev/null
docker volume create "$home_volume" >/dev/null
docker volume create "$control_volume" >/dev/null

# Model the init-container handoff required by Kubernetes emptyDir/PVC mounts.
# fsGroup alone normally leaves a volume root owned by root with group-writable
# mode; the managed restart contract deliberately requires runtime UID ownership
# and 0700. Seed a pre-existing secrets file at the same time so this test covers
# an ownership handoff, not only a file created by the runtime from scratch.
docker run --rm \
  --user 0:0 \
  --entrypoint sh \
  -v "${agent_volume}:/seed/agent" \
  -v "${home_volume}:/seed/home" \
  -v "${control_volume}:/seed/control" \
  "$image" -ec '
    umask 077
    mkdir -p \
      /seed/agent/node_modules/typeclaw-gws-multi-account \
      /seed/agent/workspace \
      /seed/home \
      /seed/control
    printf "%s\n" "{}" > /seed/agent/typeclaw.json
    printf "%s\n" "{\"version\":2,\"providers\":{},\"channels\":{}}" > /seed/agent/secrets.json
    printf "%s\n" "CLAUDE_CONFIG_DIR=/agent/workspace/claude" > /seed/agent/.env
    printf "%s\n" \
      "{\"name\":\"typeclaw-gws-multi-account\",\"version\":\"0.0.0-stale\",\"type\":\"module\",\"main\":\"index.js\"}" \
      > /seed/agent/node_modules/typeclaw-gws-multi-account/package.json
    printf "%s\n" "throw new Error(\"stale Agent Folder GWS package was loaded\")" \
      > /seed/agent/node_modules/typeclaw-gws-multi-account/index.js
    chown -R 65532:65532 /seed/agent /seed/home /seed/control
    find /seed/agent /seed/home /seed/control -type d -exec chmod 0700 {} +
    find /seed/agent /seed/home /seed/control -type f -exec chmod 0600 {} +
  '

# Prove the supported sandbox/security pairing before booting TypeClaw. The
# default container-runtime seccomp profile blocks bwrap's user namespace;
# seccomp=unconfined admits it without root, added capabilities, or privilege
# escalation. Keep this argv aligned with the proc-bind path in
# src/sandbox/build.ts.
docker run --rm \
  --read-only \
  --user 65532:65532 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --security-opt seccomp=unconfined \
  --network none \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=64m \
  --entrypoint bwrap \
  "$image" \
  --unshare-all \
  --new-session \
  --die-with-parent \
  --clearenv \
  --setenv PATH /usr/local/bin:/usr/bin:/bin \
  --setenv HOME /tmp \
  --setenv LANG C.UTF-8 \
  --ro-bind /usr /usr \
  --ro-bind /etc /etc \
  --dev /dev \
  --tmpfs /tmp \
  --ro-bind-try /bin /bin \
  --ro-bind-try /sbin /sbin \
  --ro-bind-try /lib /lib \
  --ro-bind-try /lib64 /lib64 \
  --ro-bind /proc /proc \
  --chdir /tmp \
  bash -c 'test -r /proc/self/maps && test ! -w /usr'

# Run the real managed entrypoint with CLAUDE_CONFIG_DIR present only in
# /agent/.env. The probe invokes the real exporter with a synthetic OAuth token
# and proves that the model-visible path remains an alias while the 0600 bytes
# land only under the runtime HOME.
docker run --rm \
  --read-only \
  --user 65532:65532 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --security-opt seccomp=unconfined \
  --network none \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=64m \
  --shm-size=128m \
  -e TYPECLAW_CLI_ENTRY=/node_modules/typeclaw/scripts/probe-managed-entrypoint-security.ts \
  -v "${agent_volume}:/agent:rw" \
  -v "${home_volume}:/home/typeclaw:rw" \
  "$image"

docker run -d \
  --name "$container_name" \
  --read-only \
  --user 65532:65532 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --security-opt seccomp=unconfined \
  --network none \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m \
  --shm-size=256m \
  -e TYPECLAW_RUNTIME_ID=smoke-runtime \
  -e TYPECLAW_MANAGED_CONTROL_DIR=/run/typeclaw-managed \
  -v "${agent_volume}:/agent:rw" \
  -v "${home_volume}:/home/typeclaw:rw" \
  -v "${control_volume}:/run/typeclaw-managed:rw" \
  "$image" \
  run --no-tui >/dev/null
started=1

ready=0
for _ in $(seq 1 240); do
  if docker exec "$container_name" bun -e '
    const response = await fetch("http://127.0.0.1:8973/health/ready")
    const body = await response.json()
    if (response.status === 200 && body.ready === true) {
      if (body.status !== "ready" || body.degraded !== false) process.exit(42)
      process.exit(0)
    }
    process.exit(1)
  ' >/dev/null 2>&1; then
    ready=1
    break
  else
    probe_status=$?
    if [[ "$probe_status" == "42" ]]; then
      echo "managed runtime became ready in a degraded state" >&2
      docker logs "$container_name" >&2 || true
      exit 1
    fi
  fi
  sleep 0.5
done

if [[ "$ready" != "1" ]]; then
  echo "managed runtime did not become ready" >&2
  docker logs "$container_name" >&2 || true
  exit 1
fi

docker exec "$container_name" bun -e '
  for (const path of ["/health/live", "/health/ready"]) {
    const response = await fetch("http://127.0.0.1:8973" + path)
    const body = await response.json()
    if (
      response.status !== 200 ||
      body.schemaVersion !== 1 ||
      body.status !== "ready" ||
      body.ready !== true ||
      body.degraded !== false
    ) {
      throw new Error(path + ": status=" + response.status + " body=" + JSON.stringify(body))
    }
  }
'

# Assert the immutable graph is executable, not just present on disk. The stale
# Agent Folder GWS package planted above throws on import; resolving and booting
# cleanly proves that an injected managed default came from /node_modules.
docker exec "$container_name" sh -ec '
  test ! -e /node_modules/node_modules
  cd /node_modules/typeclaw
  bun -e '\''await import("zod")'\''
'
docker exec "$container_name" bun -e '
  import { GWS_MULTI_ACCOUNT_PLUGIN_PACKAGE } from "/node_modules/typeclaw/src/config/index.ts"
  import { createManagedDefaultPluginLoader } from "/node_modules/typeclaw/src/run/index.ts"

  const load = createManagedDefaultPluginLoader("managed", [])
  if (!load) throw new Error("managed default plugin loader was not composed")
  const resolved = await load(GWS_MULTI_ACCOUNT_PLUGIN_PACKAGE, "/agent")
  const imagePackage = await Bun.file(`/node_modules/${GWS_MULTI_ACCOUNT_PLUGIN_PACKAGE}/package.json`).json()
  if (resolved.version !== imagePackage.version || resolved.version === "0.0.0-stale") {
    throw new Error(`managed GWS resolved ${resolved.version}, image owns ${imagePackage.version}`)
  }
'

# Exercise the browser CLI as the locked-down runtime UID. This catches package
# targets left below root-only directories and architecture-specific Chromium
# paths that static Dockerfile assertions cannot detect.
docker exec "$container_name" sh -ec '
  test -x /usr/local/bin/typeclaw-chromium
  agent-browser --version
  agent-browser open about:blank
  agent-browser close
'

# Exercise both writable managed capabilities inside the same locked-down
# container. This verifies profile selection, init ownership, file locks,
# atomic rename, and the externally-owned replacement lifecycle.
docker exec "$container_name" bun -e '
  import { createRuntimeCapabilities } from "/node_modules/typeclaw/src/capabilities/index.ts"

  const caps = createRuntimeCapabilities(process.env, "/agent/secrets.json")
  if (caps.secrets === null || caps.restarter == null) {
    throw new Error("managed runtime capabilities were not resolved")
  }
  await caps.secrets.writeBackChannelBlock({
    discord: { currentAccount: null, accounts: {} },
  })
  const restart = await caps.restarter.requestRestart({ build: false })
  if (!restart.ok) throw new Error(restart.reason)
'

docker exec "$container_name" bun -e '
  import { readdir, stat } from "node:fs/promises"

  const secrets = await Bun.file("/agent/secrets.json").json()
  if (secrets.version !== 2 || secrets.channels?.discord?.currentAccount !== null) {
    throw new Error("unexpected secrets envelope: " + JSON.stringify(secrets))
  }
  const files = (await readdir("/run/typeclaw-managed")).filter(
    (name) => name.startsWith("restart-") && name.endsWith(".json"),
  )
  if (files.length !== 1) throw new Error("expected one restart request, got " + files.length)
  const requestPath = "/run/typeclaw-managed/" + files[0]
  const request = await Bun.file(requestPath).json()
  if (request.schemaVersion !== 1 || request.kind !== "restart" || request.runtimeId !== "smoke-runtime") {
    throw new Error("unexpected restart request: " + JSON.stringify(request))
  }
  const control = await stat("/run/typeclaw-managed")
  const requestFile = await stat(requestPath)
  const uid = process.getuid?.()
  if ((control.mode & 0o777) !== 0o700 || (uid !== undefined && control.uid !== uid)) {
    throw new Error("managed control directory ownership/mode contract was not preserved")
  }
  if ((requestFile.mode & 0o777) !== 0o600 || (uid !== undefined && requestFile.uid !== uid)) {
    throw new Error("managed restart request ownership/mode contract was not preserved")
  }
'

test "$(docker exec "$container_name" stat -c '%a' /agent/secrets.json)" = "600"
test "$(docker exec "$container_name" stat -c '%u:%g' /agent/secrets.json)" = "65532:65532"
