#!/bin/bash
set -eu

echo "[entrypoint] setup appdata permissions"
chown -R "$UID:$GID" /app/appdata || echo "WARNING! Could not change appdata ownership"
exec gosu "$UID:$GID" "$@"
