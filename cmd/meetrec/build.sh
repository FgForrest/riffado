#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
output_path=${1:-"$script_dir/meetrec"}

cd "$repository_root"
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$output_path" ./cmd/meetrec
printf 'Built %s\n' "$output_path"
