#!/bin/sh
set -eu

APP_USER="${OMNISIGHT_RUN_USER:-omnisight}"
APP_GROUP="${OMNISIGHT_RUN_GROUP:-omnisight}"
DATA_DIR="${OMNISIGHT_DATA_DIR:-/app/data}"

if [ "$#" -eq 0 ] || [ "${1:-}" = "omnisight-run" ]; then
  MODE="${OMNISIGHT_MODE:-prod}"
  export OMNISIGHT_START_DEMO=0
  case "$MODE" in
    prod|production|server)
      export PORT="${PORT:-3000}"
      set -- npm start
      ;;
    demo)
      if [ -z "${PORT:-}" ] || [ "$PORT" = "3000" ]; then
        export PORT="${OMNISIGHT_DEMO_PORT:-4000}"
      fi
      set -- npm run demo
      ;;
    *)
      echo "OmniSight error: unsupported OMNISIGHT_MODE=$MODE; use prod or demo" >&2
      exit 64
      ;;
  esac
fi

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if ! chown -R "$APP_USER:$APP_GROUP" "$DATA_DIR"; then
    echo "OmniSight warning: could not chown $DATA_DIR; existing data may be unreadable" >&2
  fi
  find "$DATA_DIR" -type d -exec chmod u+rwx {} + 2>/dev/null || true
  find "$DATA_DIR" -type f -exec chmod u+rw {} + 2>/dev/null || true
  exec su-exec "$APP_USER:$APP_GROUP" "$@"
fi

exec "$@"
