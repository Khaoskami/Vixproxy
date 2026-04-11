#!/bin/sh
# Railway volume mounts come back as root:root on every boot.
# Run as root only long enough to fix ownership of the data dir,
# then drop to the unprivileged vixproxy user before exec'ing the
# real command.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

mkdir -p "$DATA_DIR"
chown -R vixproxy:vixproxy "$DATA_DIR"

exec su-exec vixproxy "$@"
