#!/bin/bash
set -eu

# running the container as user
if [ "$(id -u)" -ne 0 ]; then
  exec "$@"
fi

echo "[entrypoint] setup appdata permissions"
chown -R "$UID:$GID" /app/appdata || echo "WARNING! Could not change appdata ownership"
exec gosu "$UID:$GID" "$@"
