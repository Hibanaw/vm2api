#!/bin/sh
set -eu

ROOT=$1
PROJECT=$2
CONTAINER=$3
PREVIOUS_ID=$4
TAG=$5
ARCH=$6
shift 6
cd "$ROOT"

QUOTA_IMAGE=
VERSION_TAG=$TAG
if printf '%s\n' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+-quota\.[a-f0-9]{12}-amd64$'; then
  [ "$ARCH" = amd64 ] && [ ! -d .git ] || { echo 'Quota upgrades require an amd64 image deployment' >&2; exit 1; }
  QUOTA_IMAGE=ghcr.io/hibanaw/vm2api-quota
  VERSION_TAG=${TAG%%-quota.*}
fi

COMPOSE_FILE_LIST=''
for file do
  if [ -n "$COMPOSE_FILE_LIST" ]; then COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST:"; fi
  COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST$file"
done

compose() {
  COMPOSE_FILE="$COMPOSE_FILE_LIST" env -u DOCKER_DEFAULT_PLATFORM docker compose \
    --project-directory "$ROOT" --project-name "$PROJECT" "$@"
}

# Use the HTTP server's kernel client, so this also catches auth/protocol regressions.
# Busy kernels may have no idle slots; process health still has to survive the update.
probe() {
  docker exec "$CONTAINER" node --input-type=module -e '
    const [mode, target, baseline = "[]"] = process.argv.slice(1)
    const port = process.env.PORT || "8787"
    const base = `http://127.0.0.1:${port}`
    const key = process.env.KIN_API_KEY || process.env.VM2API_API_KEY || ""
    const refill = Number(process.env.KIN_RATE_REFILL || 1)
    const interval = Number.isFinite(refill) && refill > 0 ? Math.min(30000, Math.ceil(1000 / refill)) : 1000
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    let nextRequestAt = 0

    async function json(path) {
      for (let attempt = 0; ; attempt++) {
        await sleep(Math.max(0, nextRequestAt - Date.now()))
        nextRequestAt = Date.now() + interval
        const res = await fetch(`${base}${path}`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(12000),
        })
        if (res.ok) {
          const body = await res.json()
          return body.data || body
        }
        const retryAfter = res.headers.get("retry-after")
        await res.body?.cancel()
        if (res.status !== 429 || attempt >= 3) throw new Error(`${path}: HTTP ${res.status}`)

        const retryMs = retryAfter === null ? 0 : /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now()
        const delay = Math.max(interval, 2000 * 2 ** attempt, Number.isFinite(retryMs) ? retryMs : 0)
        if (delay > 30000) throw new Error(`${path}: HTTP 429; Retry-After exceeds the 30s probe retry limit`)
        console.error(`${path}: HTTP 429; retrying in ${delay}ms`)
        nextRequestAt = Date.now() + delay
      }
    }
    function kernelHealthy(detail) {
      const kernel = detail.kernel
      const health = kernel?.codex_health || kernel?.rust_health || kernel?.go_health
      return health?.status === 200 && health.process_up !== false && health.healthy !== false
    }
    try {
      if (mode === "snapshot") {
        const list = await json("/api/panel/vms")
        const vms = Array.isArray(list) ? list : list.items
        if (!Array.isArray(vms)) throw new Error("Invalid slot list")
        const healthy = []
        for (const vm of vms.filter(vm => vm.status === "running")) {
          if (kernelHealthy(await json(`/api/panel/vms/${encodeURIComponent(vm.id)}`))) {
            healthy.push(vm.id)
          }
        }
        console.log(JSON.stringify(healthy))
      } else {
        const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
        if (!health.ok) throw new Error(`Backend health: HTTP ${health.status}`)
        const version = await json("/api/panel/version")
        if (version.current_tag !== target) throw new Error(`Backend still at ${version.current_tag}`)
        for (const id of JSON.parse(baseline)) {
          if (!kernelHealthy(await json(`/api/panel/vms/${encodeURIComponent(id)}`))) {
            throw new Error(`Previously healthy slot ${id} failed kernel verification`)
          }
        }
      }
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  ' "$@"
}

# Let the update request return before replacing its own HTTP server.
sleep 2
BASELINE=$(probe snapshot "$TAG")
echo "Recording healthy slot kernels before upgrade: $BASELINE"
if [ -d .git ]; then
  if [ "$ARCH" = arm64 ]; then
    case ":$COMPOSE_FILE_LIST:" in
      *":$ROOT/docker-compose.arm64.yml:"*) ;;
      *) echo 'ARM64 source install lacks docker-compose.arm64.yml' >&2; exit 1 ;;
    esac
  fi
  export GIT_TERMINAL_PROMPT=0
  command -v git >/dev/null || apk add --no-cache git >/dev/null
  git config --global --add safe.directory "$ROOT"
  # History was rewritten once to drop build artifacts; --force lets old clones take the new tags.
  git fetch --force --tags origin
  # Routing and interception rules are tracked defaults but live operator config.
  CONFIG_BACKUP=$(mktemp -d)
  if [ -d src/config ]; then cp -a src/config "$CONFIG_BACKUP/config"; fi
  restore_config() {
    if [ -d "$CONFIG_BACKUP/config" ]; then
      mkdir -p src/config
      cp -a "$CONFIG_BACKUP/config/." src/config/
    fi
    rm -rf "$CONFIG_BACKUP"
  }
  if ! git checkout -f --detach "$TAG"; then
    restore_config
    exit 1
  fi
  restore_config
  chmod 755 bin/kin-* 2>/dev/null || true
  grep -q '^!CHANGELOG.md$' .dockerignore 2>/dev/null || printf '\n!CHANGELOG.md\n' >> .dockerignore
  if [ "$ARCH" = amd64 ]; then
    case ":$COMPOSE_FILE_LIST:" in
      *":$ROOT/docker-compose.build.yml:"*) ;;
      *) COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST:$ROOT/docker-compose.build.yml" ;;
    esac
  fi
  compose build vm2api
else
  IMAGE_TAG=$TAG
  [ "$ARCH" != arm64 ] || IMAGE_TAG=$TAG-arm64
  if [ -n "$QUOTA_IMAGE" ]; then
    docker pull "$QUOTA_IMAGE:$IMAGE_TAG"
    image_identity=$(docker image inspect "$QUOTA_IMAGE:$IMAGE_TAG" --format '{{range .Config.Env}}{{println .}}{{end}}' |
      grep -Fx "VM2API_QUOTA_IMAGE_TAG=$IMAGE_TAG")
    [ -n "$image_identity" ]
    umask 077
    mkdir -p deployment-backups
    backup=$(mktemp -d deployment-backups/quota-upgrade.XXXXXX)
    cp -p .env "$backup/.env"
    docker exec "$CONTAINER" node --input-type=module -e '
      import { DatabaseSync, backup } from "node:sqlite"
      import path from "node:path"
      process.umask(0o077)
      const source = new DatabaseSync(process.env.KIN_DB_PATH || path.join(process.env.KIN_DATA_DIR || "/opt/vm2api/data", "kin.db"), { readOnly: true })
      await backup(source, "/tmp/vm2api-quota-" + process.argv[1] + ".db")
      source.close()
    ' "${backup##*/}"
    docker cp "$CONTAINER:/tmp/vm2api-quota-${backup##*/}.db" "$backup/kin.db"
    chmod 600 "$backup/kin.db"
    docker exec "$CONTAINER" rm -f "/tmp/vm2api-quota-${backup##*/}.db"
    echo "Upgrade backup: $backup"
  fi
  if [ -n "$QUOTA_IMAGE" ]; then
    pending_env=$(mktemp "$ROOT/.env.quota.XXXXXX")
    trap 'rm -f "$pending_env"' EXIT
    sed '/^VM2API_IMAGE=/d; /^VM2API_IMAGE_TAG=/d' .env > "$pending_env"
    printf '\nVM2API_IMAGE=%s\nVM2API_IMAGE_TAG=%s\n' "$QUOTA_IMAGE" "$IMAGE_TAG" >> "$pending_env"
    resolved_image=$(compose --env-file "$pending_env" config --images vm2api)
    [ "$resolved_image" = "$QUOTA_IMAGE:$IMAGE_TAG" ] || { echo 'Compose does not select the quota image' >&2; exit 1; }
  else
    touch .env
    if grep -q '^VM2API_IMAGE_TAG=' .env; then
      sed -i.bak "s|^VM2API_IMAGE_TAG=.*|VM2API_IMAGE_TAG=$IMAGE_TAG|" .env
      rm -f .env.bak
    else
      printf '\nVM2API_IMAGE_TAG=%s\n' "$IMAGE_TAG" >> .env
    fi
    compose pull vm2api
  fi
  # Image upgrades do not refresh Compose files. Add only the bind missing
  # from the effective configuration; leave operator files and mounts alone.
  CONFIG=$(compose config --format json vm2api)
  HAS_CRAG_BIND=$(printf '%s' "$CONFIG" | docker exec -i "$CONTAINER" node -e '
    try {
      const { volumes = [] } = JSON.parse(require("node:fs").readFileSync(0, "utf8")).services.vm2api
      console.log(volumes.some(({ target }) => target === "/run/crag-host-machine-id") ? "yes" : "no")
    } catch {
      console.error("Could not inspect the vm2api Compose mounts")
      process.exit(1)
    }
  ')
  unset CONFIG
  if [ "$HAS_CRAG_BIND" = no ]; then
    # Keep the overlay on disk: Compose records its path for later panel upgrades.
    CRAG_BIND_FILE=$(mktemp "$ROOT/.vm2api-crag-host-machine-id.XXXXXX")
    cat > "$CRAG_BIND_FILE" <<'EOF'
services:
  vm2api:
    volumes:
      - type: bind
        source: "${VM2API_CRAG_HOST_ID_FILE:-/etc/machine-id}"
        target: /run/crag-host-machine-id
        read_only: true
        bind:
          create_host_path: false
EOF
    chmod 0644 "$CRAG_BIND_FILE"
    COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST:$CRAG_BIND_FILE"
  fi
fi

if [ -n "$QUOTA_IMAGE" ]; then
  mv -f "$pending_env" .env
  trap - EXIT
  if ! compose up -d --no-deps --force-recreate --pull never vm2api; then
    if [ "$(docker inspect --format '{{.Id}}' "$CONTAINER" 2>/dev/null)" = "$PREVIOUS_ID" ]; then
      cp -p "$backup/.env" .env
    fi
    echo "Compose failed. See backup: $backup" >&2
    exit 1
  fi
else
  compose up -d --no-deps --force-recreate vm2api
fi
CURRENT_ID=$(docker inspect --format '{{.Id}}' "$CONTAINER")
if [ "$CURRENT_ID" = "$PREVIOUS_ID" ]; then
  echo 'Compose did not replace the running control plane' >&2
  exit 1
fi

# Check the backend and previously healthy slots, rather than trusting VERSION.
attempt=0
while [ "$attempt" -lt 45 ]; do
  if probe verify "$TAG" "$BASELINE"; then
    [ -d .git ] || printf '%s\n' "${VERSION_TAG#v}" > VERSION
    # Slot payloads through the new server (it alone holds the cluster links):
    # local slots take the new kernel/cli-node files, node slots move onto a
    # rebuilt slot image, then every slot restarts kin-worker/kin-egress.
    # Older control-plane images may not carry the helper yet; retry on the
    # next image update instead of invalidating an otherwise verified upgrade.
    if ! docker exec "$CONTAINER" test -f /opt/vm2api/scripts/fleet-services.mjs >/dev/null 2>&1; then
      echo "Slot refresh helper is not present in the control plane; retry after the next image update" >&2
    elif ! docker exec "$CONTAINER" node /opt/vm2api/scripts/fleet-services.mjs; then
      echo "Slot payload/service refresh failed; inspect the per-slot report" >&2
      exit 1
    fi
    echo "Control plane restarted and verified at $TAG"
    echo "Previously healthy slot kernels verified: $BASELINE"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done
echo "Control plane or previously healthy slot kernels did not become healthy at $TAG" >&2
exit 1
