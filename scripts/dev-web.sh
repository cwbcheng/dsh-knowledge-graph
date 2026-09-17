#!/usr/bin/env bash
#
# Boot a dsh web instance from the SOURCE checkout in /mnt/d/github with this
# plugin installed, on its own port and profile, so it never touches the
# instance you normally run.
#
#   scripts/dev-web.sh                  # start in the foreground (Ctrl-C stops)
#   scripts/dev-web.sh --detach         # background it, print the URL, exit
#   scripts/dev-web.sh --stop           # stop a detached instance
#   scripts/dev-web.sh --rebuild        # pnpm install + build harness AND plugin
#   scripts/dev-web.sh --port 4000      # pick another port
#   scripts/dev-web.sh --browser        # also open the system browser
#
# Everything is overridable by environment variable (see below), so this works
# from any checkout, not just this machine's paths.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_NAME="$(node -p "require('${PLUGIN_DIR}/package.json').name" 2>/dev/null || basename "$PLUGIN_DIR")"

# --- configuration ----------------------------------------------------------
DSH_REPO="${DSH_REPO:-/mnt/d/github/deepseek-harness}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_DEV_PROFILE:-kgsrc}"
PORT="${DSH_DEV_PORT:-3099}"
HOST="${DSH_DEV_HOST:-}"
LOG_FILE="${DSH_DEV_LOG:-/tmp/dsh-${PROFILE}-web.log}"
PID_FILE="${DSH_DEV_PID:-/tmp/dsh-${PROFILE}-web.pid}"

REBUILD=0
DETACH=0
STOP=0
# The web app only defines --no-open (there is no --open), and a launcher should
# not hijack the desktop browser behind your back.
NO_OPEN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --rebuild) REBUILD=1 ;;
    --detach) DETACH=1 ;;
    --stop) STOP=1 ;;
    --browser) NO_OPEN=0 ;;
    --port) PORT="${2:?--port needs a value}"; shift ;;
    --profile) PROFILE="${2:?--profile needs a value}"; shift ;;
    --host) HOST="${2:?--host needs a value}"; shift ;;
    --repo) DSH_REPO="${2:?--repo needs a value}"; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

CLI="$DSH_REPO/apps/cli/lib/bin.js"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_URL="$(printf '%s' "$PLUGIN_DIR" | sed 's/ /%20/g')"

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Prefer the harness' own pinned pnpm when it is not on PATH.
if ! have pnpm; then
  if have corepack; then pnpm() { corepack pnpm "$@"; }
  else die "pnpm is required (or corepack)"; fi
fi

# Prints the pid listening on a port, or nothing. Must never fail: it is called
# from command substitution under `set -e`, where grep finding no match would
# otherwise abort the whole script.
port_pid() {
  local out
  out="$( { ss -lptnH "sport = :$1" 2>/dev/null || true; } | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true )"
  printf '%s' "$out"
}

# --- --stop -----------------------------------------------------------------
if [ "$STOP" = 1 ]; then
  stopped=0
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" && stopped=1; fi
    rm -f "$PID_FILE"
  fi
  pid="$(port_pid "$PORT")"
  if [ -n "$pid" ] && [ "$pid" != "$$" ]; then kill "$pid" 2>/dev/null && stopped=1; fi
  [ "$stopped" = 1 ] && log "stopped the dev instance on port $PORT" || log "nothing was listening on port $PORT"
  exit 0
fi

# --- 1. the harness checkout must exist and be built ------------------------
[ -d "$DSH_REPO" ] || die "harness checkout not found: $DSH_REPO (set DSH_REPO)"
[ -f "$DSH_REPO/pnpm-workspace.yaml" ] || die "$DSH_REPO does not look like the deepseek-harness monorepo"

if [ "$REBUILD" = 1 ]; then
  log "[1/4] building the harness (pnpm install + build)…"
  ( cd "$DSH_REPO" && pnpm install --frozen-lockfile && pnpm build )
elif [ ! -f "$CLI" ]; then
  log "[1/4] $CLI is missing — building the harness for the first time…"
  ( cd "$DSH_REPO" && pnpm install --frozen-lockfile && pnpm build )
else
  log "[1/4] harness already built: $(node "$CLI" --version)"
fi

# --- 2. this plugin's own artifacts ------------------------------------------
# The profile links this directory, so dsh serves lib/index.js and lib/client.js
# straight from here. A stale lib is the single most confusing failure mode:
# the UI silently keeps the previous client bundle.
if [ "$REBUILD" = 1 ] || [ ! -f "$PLUGIN_DIR/lib/index.js" ] || [ ! -f "$PLUGIN_DIR/lib/client.js" ]; then
  log "[2/4] building $PLUGIN_NAME…"
  ( cd "$PLUGIN_DIR" && npm run build >/dev/null )
else
  newer="$(find "$PLUGIN_DIR/src" -newer "$PLUGIN_DIR/lib/client.js" -name '*.js' -print -quit 2>/dev/null || true)"
  if [ -n "$newer" ]; then
    log "[2/4] WARNING: src is newer than lib — run with --rebuild or the UI will serve the old client"
  else
    log "[2/4] $PLUGIN_NAME artifacts are current"
  fi
fi

# --- 3. the profile: web template + this plugin as a bundle layer ------------
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  log "[3/4] creating profile '$PROFILE' from the shipped web template…"
  # A bare `plugin --profile X add` initializes the MINIMAL template, which has
  # no web app at all; the parent command is what pulls in @deepseek-ai/dsh-web-app.
  ( cd "$DSH_REPO" && node "$CLI" --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null )
fi

bundles="$(node -e "
  const m = require('$PROFILE_DIR/package.json')
  const list = m?.dsh?.profile?.bundles ?? []
  process.stdout.write(list.join(','))
" 2>/dev/null || echo '')"
case ",$bundles," in
  *",$PLUGIN_NAME,"*) log "[3/4] profile '$PROFILE' already carries $PLUGIN_NAME as a bundle" ;;
  *)
    log "[3/4] installing $PLUGIN_NAME into profile '$PROFILE'…"
    ( cd "$DSH_REPO" && node "$CLI" plugin --profile "$PROFILE" add "$PLUGIN_URL" )
    ;;
esac

if [ "$PROFILE" = "web" ]; then
  log "      note: 'web' is the profile you normally run — this will have modified it"
fi

# --- 4. start ----------------------------------------------------------------
existing="$(port_pid "$PORT")"
if [ -n "$existing" ]; then
  die "port $PORT is already in use (pid $existing) — use --port, or --stop to kill it"
fi

args=(--profile "$PROFILE" --port "$PORT")
[ "$NO_OPEN" = 1 ] && args+=(--no-open)
[ -n "$HOST" ] && args+=(--host "$HOST")

log "[4/4] starting dsh web on port $PORT (profile '$PROFILE')…"
cd "$DSH_REPO"

if [ "$DETACH" = 1 ]; then
  nohup node "$CLI" "${args[@]}" > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
else
  # Mirror to a log while staying in the foreground so Ctrl-C works.
  node "$CLI" "${args[@]}" 2>&1 | tee "$LOG_FILE" &
  server_pid=$!
  echo "$server_pid" > "$PID_FILE"
  trap 'kill "$server_pid" 2>/dev/null || true' INT TERM EXIT
fi

# Wait for the token URL, then prove the plugin actually answers. Starting is not
# the same as working: a plugin can fail to load and still serve the shell.
url=""
for _ in $(seq 1 60); do
  url="$(grep -o 'http://[^ ]*token=[A-Za-z0-9_-]*' "$LOG_FILE" 2>/dev/null | head -1 || true)"
  [ -n "$url" ] && break
  if [ "$DETACH" = 1 ]; then
    kill -0 "$(cat "$PID_FILE")" 2>/dev/null || { log "server exited during startup:"; tail -20 "$LOG_FILE" >&2; exit 1; }
  fi
  sleep 1
done

[ -n "$url" ] || { log "no URL after 60s; last log lines:"; tail -20 "$LOG_FILE" >&2; exit 1; }

base="http://127.0.0.1:$PORT"
health="$(curl -s -m 10 "$base/api/$PLUGIN_NAME/ontology-list" 2>/dev/null || true)"
case "$health" in
  *'"ontologies"'*)
    log ""
    log "  $url"
    log ""
    log "  health: $PLUGIN_NAME responded on $base/api/$PLUGIN_NAME/ontology-list"
    ;;
  *)
    log ""
    log "  $url"
    log ""
    log "  WARNING: $PLUGIN_NAME did not answer on $base/api/$PLUGIN_NAME/ontology-list"
    log "           the shell is up, so check the plugin layer in $LOG_FILE"
    ;;
esac

if [ "$DETACH" = 1 ]; then
  log "  log:  $LOG_FILE"
  log "  stop: $0 --stop --port $PORT"
else
  wait "$server_pid"
fi
