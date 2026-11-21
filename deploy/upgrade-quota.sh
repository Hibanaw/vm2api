#!/usr/bin/env bash
set -euo pipefail

mode=${1:-upgrade}
case "$mode" in upgrade|check) ;; *) echo 'Usage: upgrade-quota.sh [upgrade|check] [--version TAG]' >&2; exit 2 ;; esac
if (($#)); then shift; fi
tag_pattern='^v[0-9]+\.[0-9]+\.[0-9]+-quota\.[a-f0-9]{12}-amd64$'
endpoint=latest
if (($#)); then
  [[ $# == 2 && $1 == --version && $2 =~ $tag_pattern ]] || { echo 'Invalid quota release tag' >&2; exit 2; }
  endpoint="tags/$2"
fi
tag=$(curl -fsSL --max-time 20 "https://api.github.com/repos/Hibanaw/vm2api/releases/$endpoint" |
  python3 -c 'import json, sys; release = json.load(sys.stdin); print(release["tag_name"] if not release["draft"] and not release["prerelease"] else "")')
[[ $tag =~ $tag_pattern && ( $endpoint == latest || $endpoint == "tags/$tag" ) ]]
if [[ $mode == check ]]; then
  printf '%s\n' "$tag"
  exit 0
fi
[[ $EUID == 0 && $(uname -m) == x86_64 ]] || { echo 'Run as root on an amd64 host' >&2; exit 1; }
container=${VM2API_CONTAINER_NAME:-vm2api}
record=$(docker inspect --format '{{json .}}' "$container" | python3 -c '
import json, sys
container = json.load(sys.stdin)
labels = container["Config"]["Labels"]
if not container["State"]["Running"] or labels.get("com.docker.compose.service") != "vm2api":
    sys.exit("No running vm2api Compose service")
for key in ("project.working_dir", "project", "project.config_files"):
    print(labels["com.docker.compose." + key])
print(container["Id"])
')
mapfile -t deployment <<< "$record"
root=${deployment[0]}
project=${deployment[1]}
id=${deployment[3]}
IFS=, read -r -a files <<< "${deployment[2]}"
[[ $project =~ ^[a-z0-9][a-z0-9_-]*$ && $root == /* && $root != / && -f $root/.env && ! -d $root/.git ]]
for file in "${files[@]}"; do
  [[ $file == "$root/"* && -f $file ]] || { echo 'Unexpected Compose config path' >&2; exit 1; }
done
[[ ${#files[@]} -gt 0 ]]
image="ghcr.io/hibanaw/vm2api-quota:$tag"
current_image=$(docker inspect --format '{{.Config.Image}}' "$container")
if [[ $current_image == "$image" ]]; then
  echo "Already running $tag"
  exit 0
fi
current_version=$(docker exec "$container" cat /opt/vm2api/VERSION)
target_version=${tag%%-quota.*}
if [[ $current_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] &&
   [[ $(printf '%s\n' "$current_version" "${target_version#v}" | sort -V | tail -1) != "${target_version#v}" ]]; then
  echo "Target $tag is older than the running release v$current_version" >&2
  exit 1
fi
script=$(curl -fsSL --max-time 20 'https://raw.githubusercontent.com/Hibanaw/vm2api/dev/scripts/panel-upgrade.sh')
[[ -n $script ]]
helper="vm2api-upgrade-$project"
if state=$(docker inspect --format '{{.State.Status}}' "$helper" 2>/dev/null); then
  [[ $state == exited ]] || { echo "Upgrade already in progress: $helper" >&2; exit 1; }
  docker rm "$helper" >/dev/null
fi
docker run --name "$helper" --label "vm2api.upgrade.target=$tag" \
  -v "$root:$root" -v /var/run/docker.sock:/var/run/docker.sock -w "$root" \
  docker:27-cli sh -c "$script" panel-upgrade "$root" "$project" "$container" "$id" "$tag" amd64 "${files[@]}"
