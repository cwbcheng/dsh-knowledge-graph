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
#   scripts/dev-web.sh --safe-runtime   # diagnostic native-crash workaround
#
# Everything is overridable by environment variable (see below), so this works
# from any checkout, not just this machine's paths.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- configuration ----------------------------------------------------------
DSH_REPO="${DSH_REPO:-/mnt/d/github/deepseek-harness}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_DEV_PROFILE:-kgsrc}"
PORT="${DSH_DEV_PORT:-3099}"
HOST="${DSH_DEV_HOST:-}"
STARTUP_SECONDS="${DSH_DEV_STARTUP_SECONDS:-60}"

REBUILD=0
DETACH=0
STOP=0
SAFE_RUNTIME=0
# The web app only defines --no-open (there is no --open), and a launcher should
# not hijack the desktop browser behind your back.
NO_OPEN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --rebuild) REBUILD=1 ;;
    --detach) DETACH=1 ;;
    --stop) STOP=1 ;;
    --safe-runtime) SAFE_RUNTIME=1 ;;
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

LOG_FILE="${DSH_DEV_LOG:-/tmp/dsh-${PROFILE}-web.log}"
PID_FILE="${DSH_DEV_PID:-/tmp/dsh-${PROFILE}-web.pid}"
CLI="$DSH_REPO/apps/cli/lib/bin.js"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_URL="$(printf '%s' "$PLUGIN_DIR" | sed 's/ /%20/g')"

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )) || die "invalid port: $PORT"
[[ "$STARTUP_SECONDS" =~ ^[0-9]+$ ]] && (( STARTUP_SECONDS > 0 )) || die "invalid startup timeout"
have flock || die "flock is required"
exec 9>"$PID_FILE.lock"
flock -n 9 || die "another launcher is starting this profile"

# A PID alone can be recycled. Match the kernel start time before signalling it.
process_start() {
  local stat
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  stat="${stat##*) }"
  set -- $stat
  [ "$1" != Z ] || return 1
  printf '%s' "${20}"
}
owned_process() {
  [ -n "${pid:-}" ] && [ -n "${started:-}" ] && [ "$(process_start "$pid" || true)" = "$started" ]
}

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
  if [ -f "$PID_FILE" ]; then
    read -r pid started < "$PID_FILE" || true
    if owned_process; then
      kill -TERM "$pid"
      for _ in $(seq 1 50); do owned_process || break; sleep 0.1; done
      owned_process && die "process $pid has not stopped; PID record retained"
      rm -f -- "$PID_FILE"
      log "stopped the dev instance (pid $pid)"
      exit 0
    fi
  fi
  log "no owned live process; no process was signalled (stale/legacy PID records are not trusted)"
  exit 0
fi

# NVM/npm may prepend an old runtime. Select one Node for the CLI and builds,
# without changing the user's global NVM default. This is a crash workaround.
NODE_BIN="${DSH_DEV_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  while IFS= read -r candidate; do
    if "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
      NODE_BIN="$candidate"; break
    fi
  done < <(type -aP node)
fi
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || die "Node not found; set DSH_DEV_NODE to a Node 24+ executable"
NODE_BIN="$(readlink -f "$NODE_BIN")"
"$NODE_BIN" -e 'const v=process.versions.node; const [major,minor]=v.split(".").map(Number); process.exit(v !== "22.20.0" && (major >= 24 || (major === 22 && minor >= 19)) ? 0 : 1)' || die "unsupported/known-crashing Node; set DSH_DEV_NODE to Node 24+ (22.20.0 is blocked by this launcher only)"
export PATH="$(dirname "$NODE_BIN"):$PATH"
export DSH_HOME
log "runtime: $NODE_BIN ($("$NODE_BIN" --version))"
node_args=()
if [ "$SAFE_RUNTIME" = 1 ]; then
  # --jitless also removes WebAssembly, breaking Node 24's fetch/undici parser.
  node_args+=(--no-opt --no-maglev --no-sparkplug --regexp-interpret-all)
  log "runtime mode: JS/regexp interpreter (diagnostic workaround; WebAssembly retained)"
fi
PLUGIN_NAME="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).name' "$PLUGIN_DIR/package.json")"
pnpm_build() {
  if have pnpm; then pnpm "$@"
  elif have corepack; then corepack pnpm "$@"
  else die "pnpm or corepack is required to build/install"; fi
}
existing="$(port_pid "$PORT")"
[ -z "$existing" ] || die "port $PORT is already in use (pid $existing); no process was stopped"
if [ -f "$PID_FILE" ]; then
  read -r pid started < "$PID_FILE" || true
  owned_process && die "this profile already has a live process (pid $pid)"
fi

# --- 1. the harness checkout must exist and be built ------------------------
[ -d "$DSH_REPO" ] || die "harness checkout not found: $DSH_REPO (set DSH_REPO)"
[ -f "$DSH_REPO/pnpm-workspace.yaml" ] || die "$DSH_REPO does not look like the deepseek-harness monorepo"

if [ "$REBUILD" = 1 ]; then
  log "[1/4] building the harness (pnpm install + build)…"
  ( cd "$DSH_REPO" && pnpm_build install --frozen-lockfile && pnpm_build build )
elif [ ! -f "$CLI" ]; then
  log "[1/4] $CLI is missing — building the harness for the first time…"
  ( cd "$DSH_REPO" && pnpm_build install --frozen-lockfile && pnpm_build build )
else
  version="$(node "$CLI" --version)" || die "harness version probe failed"
  log "[1/4] harness already built: $version"
fi

# --- 2. this plugin's own artifacts ------------------------------------------
# The profile links this directory, so dsh serves lib/index.js and lib/client.js
# straight from here. A stale lib is the single most confusing failure mode:
# the UI silently keeps the previous client bundle.
if [ "$REBUILD" = 1 ] || [ ! -f "$PLUGIN_DIR/lib/index.js" ] || [ ! -f "$PLUGIN_DIR/lib/client.js" ]; then
  log "[2/4] building $PLUGIN_NAME…"
  ( cd "$PLUGIN_DIR" && npm run build >/dev/null )
else
  newer="$(find "$PLUGIN_DIR/src" "$PLUGIN_DIR/scripts" -type f \( -name '*.js' -o -name '*.mjs' \) \( -newer "$PLUGIN_DIR/lib/client.js" -o -newer "$PLUGIN_DIR/lib/index.js" \) -print -quit)"
  if [ -n "$newer" ]; then
    log "[2/4] rebuilding plugin artifacts after source/build-script changes…"
    ( cd "$PLUGIN_DIR" && npm run build >/dev/null )
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

bundles="$(node -e '
  const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  const list = m?.dsh?.profile?.bundles ?? []
  process.stdout.write(list.join(","))
' "$PROFILE_DIR/package.json")"
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

# Rotate synchronously before spawning: never read a prior process's token.
umask 077
[ ! -f "$LOG_FILE" ] || mv -- "$LOG_FILE" "$LOG_FILE.previous.$(date +%s).$$"
: > "$LOG_FILE"
if [ "$DETACH" = 1 ]; then
  # Leave the invoking terminal's process group as well as ignoring SIGHUP.
  have setsid || die "setsid is required for --detach"
  setsid nohup "$NODE_BIN" "${node_args[@]}" "$CLI" "${args[@]}" < /dev/null > "$LOG_FILE" 2>&1 9>&- &
else
  "$NODE_BIN" "${node_args[@]}" "$CLI" "${args[@]}" < /dev/null > "$LOG_FILE" 2>&1 9>&- &
fi
pid=$!
started="$(process_start "$pid")" || die "server exited immediately"
printf '%s %s\n' "$pid" "$started" > "$PID_FILE"
keep_server=0
mirror_pid=''
cookie_jar="$(mktemp)"
health_file="$(mktemp)"
cleanup() {
  if [ "$keep_server" = 0 ]; then
    if owned_process; then
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do owned_process || break; sleep 0.1; done
      if owned_process; then kill -KILL "$pid" 2>/dev/null || true; fi
      wait "$pid" 2>/dev/null || true
    fi
    [ -z "$mirror_pid" ] || kill "$mirror_pid" 2>/dev/null || true
    # Do not erase a newer launcher's record.
    [ "$(cat "$PID_FILE" 2>/dev/null || true)" != "$pid $started" ] || rm -f -- "$PID_FILE"
  fi
  rm -f -- "$cookie_jar" "$health_file"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$DETACH" = 0 ]; then
  tail --pid="$pid" -n +1 -f "$LOG_FILE" 9>&- &
  mirror_pid=$!
fi

# Wait for the token URL, then prove the plugin actually answers. Starting is not
# the same as working: a plugin can fail to load and still serve the shell.
url=""
deadline=$((SECONDS + STARTUP_SECONDS))
ready=0
probe_host="${HOST:-127.0.0.1}"
[ "$probe_host" != '0.0.0.0' ] || probe_host=127.0.0.1
[ "$probe_host" != '::' ] || probe_host='::1'
[[ "$probe_host" != *:* ]] || probe_host="[$probe_host]"
base="http://$probe_host:$PORT"
health_code='not requested'
while (( SECONDS < deadline )); do
  if ! owned_process; then
    code=0
    wait "$pid" || code=$?
    log "server exited during startup (exit $code); log: $LOG_FILE" >&2
    [ "$code" != 0 ] || code=1
    exit "$code"
  fi
  url="$(grep -o 'http://[^ ]*token=[A-Za-z0-9_-]*' "$LOG_FILE" 2>/dev/null | head -1 || true)"
  if [ -n "$url" ]; then
    token="${url##*token=}"
    # Exchange the launch token for the authority-bound browser cookie.
    curl --noproxy '*' -s -m 3 -c "$cookie_jar" "$base/?token=$token" -o /dev/null || true
    health_code="$(curl --noproxy '*' -s -m 3 -b "$cookie_jar" -H "Origin: $base" -o "$health_file" -w '%{http_code}' "$base/api/$PLUGIN_NAME/ontology-list" || true)"
    if [ "$health_code" = 200 ] && node -e 'try { const x=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); process.exit(Array.isArray(x.ontologies) && x.ontologies.length > 0 ? 0 : 1) } catch { process.exit(1) }' "$health_file"; then
      ready=1; break
    fi
  fi
  sleep 1
done
[ "$ready" = 1 ] || die "plugin readiness failed after ${STARTUP_SECONDS}s (HTTP $health_code); server stopped; inspect $LOG_FILE"
owned_process || die "server exited after health check; inspect $LOG_FILE"
log ""
log "  $base/?token=$token"
log "  health: $PLUGIN_NAME authenticated ontology-list returned HTTP 200"
flock -u 9

if [ "$DETACH" = 1 ]; then
  keep_server=1
  log "  log:  $LOG_FILE"
  log "  stop: $0 --stop --port $PORT"
else
  code=0
  wait "$pid" || code=$?
  log "server exited (exit $code); log: $LOG_FILE"
  exit "$code"
fi
