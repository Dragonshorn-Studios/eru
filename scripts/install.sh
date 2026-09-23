#!/usr/bin/env bash
# Eru installer: clone or use this checkout, write .env + key mount, start Compose.
# One-liner: curl -fsSL https://raw.githubusercontent.com/Dragonshorn-Studios/eru/main/scripts/install.sh | bash
set -euo pipefail

REPO_URL="${ERU_REPO_URL:-https://github.com/Dragonshorn-Studios/eru.git}"
REPO_REF="${ERU_REPO_REF:-main}"
DEFAULT_HOME="${ERU_HOME:-$HOME/.eru}"

NON_INTERACTIVE=0
SKIP_START=0
UPGRADE_OPENCODE=0
FORCE_ENV=0
REUSE_ENV=0

usage() {
  cat <<'EOF'
Eru installer — guided .env + Docker Compose with persistent OpenCode.

Usage:
  curl -fsSL https://raw.githubusercontent.com/Dragonshorn-Studios/eru/main/scripts/install.sh | bash
  ./scripts/install.sh
  ./scripts/install.sh --non-interactive

The script writes .env and (optionally) github-app.pem, downloads the OpenCode
CLI from GitHub releases onto a named Docker volume, and starts Compose.
OpenCode and SQLite survive compose down / Eru image rebuilds.

Options:
  --non-interactive, -y   No prompts; read config values from env
  --skip-start            Write .env and mounts only; do not run Docker Compose
  --upgrade-opencode      Reinstall OpenCode into the named volume, then restart
  --force                 Overwrite an existing .env
  -h, --help              Show this help

Environment (non-interactive, or pre-fills interactive prompts):
  ERU_HOME                    Clone destination when not run from a checkout
                              (default: ~/.eru)
  ERU_REPO_URL / ERU_REPO_REF
  ERU_PORT                    Host port (default: 3000)
  ERU_PUBLIC_URL              Printed UI URL
  ERU_UI_PASSWORD             Generated if unset
  ERU_UI_SESSION_SECRET       Generated if unset
  ERU_FORGE_TOKEN_KEY         Generated if unset
  ERU_UI_USER                 GitHub login shown in the top bar (avatar)
  ERU_OPENCODE_MODEL          Default model (provider/model); per-purpose
                              models live on /config
  ERU_OPENCODE_VERSION        Optional pinned OpenCode CLI version
  ERU_GITHUB_APP_ID           Optional; enables repo pick-list on /connect
  ERU_GITHUB_APP_INSTALLATION_ID  Optional; auto-detected when one installation
  ERU_GITHUB_APP_PRIVATE_KEY_PATH Path to the App PEM (copied to ./github-app.pem)
  ERU_GITHUB_APP_PRIVATE_KEY  PEM contents if you do not have a file

Provider API keys are saved write-only on /config (they land in OpenCode's
auth.json inside the container), so they are not prompted here.
EOF
}

die() {
  echo "install.sh: $*" >&2
  exit 1
}

log() {
  echo "=> $*"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

is_eru_checkout() {
  local dir=$1
  [[ -f "$dir/compose.yaml" && -f "$dir/Dockerfile" && -f "$dir/.env.example" && -f "$dir/package.json" ]] || return 1
  grep -q '"name": "eru"' "$dir/package.json" 2>/dev/null
}

rand_hex() {
  local bytes=${1:-32}
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    dd if=/dev/urandom bs="$bytes" count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'
  fi
}

input_tty() {
  if [[ -r /dev/tty ]]; then
    echo /dev/tty
  elif [[ -t 0 ]]; then
    echo /dev/stdin
  else
    echo ""
  fi
}

prompt() {
  local __var=$1
  local __msg=$2
  local __default=${3:-}
  local __silent=${4:-0}
  local __current="${!__var:-}"
  local __value=""
  local __tty

  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    if [[ -z "$__current" ]]; then
      printf -v "$__var" '%s' "$__default"
    fi
    return 0
  fi

  local __shown=""
  if [[ -n "$__current" ]]; then
    __shown=$__current
  else
    __shown=$__default
  fi

  __tty=$(input_tty)
  [[ -n "$__tty" ]] || die "No TTY for prompts; re-run with --non-interactive and env vars"

  local __suffix=""
  if [[ -n "$__shown" ]]; then
    if [[ "$__silent" == "1" ]]; then
      __suffix=" [set]"
    else
      __suffix=" [$__shown]"
    fi
  fi

  if [[ "$__silent" == "1" ]]; then
    printf '%s%s: ' "$__msg" "$__suffix" > /dev/tty 2>/dev/null || printf '%s%s: ' "$__msg" "$__suffix"
    IFS= read -r -s __value < "$__tty"
    printf '\n' > /dev/tty 2>/dev/null || printf '\n'
  else
    printf '%s%s: ' "$__msg" "$__suffix" > /dev/tty 2>/dev/null || printf '%s%s: ' "$__msg" "$__suffix"
    IFS= read -r __value < "$__tty"
  fi

  if [[ -z "$__value" ]]; then
    __value=${__current:-$__default}
  fi
  printf -v "$__var" '%s' "$__value"
}

prompt_required() {
  local __var=$1
  while true; do
    prompt "$@"
    if [[ -n "${!__var:-}" ]]; then
      return 0
    fi
    if [[ "$NON_INTERACTIVE" == "1" ]]; then
      die "Missing required $__var"
    fi
    echo "This value is required." > /dev/tty 2>/dev/null || echo "This value is required."
  done
}

confirm() {
  local __msg=$1
  local __default=${2:-Y}
  local __reply=""
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    [[ "$__default" == "Y" || "$__default" == "y" ]]
    return
  fi
  prompt __reply "$__msg" "$__default"
  case $(printf '%s' "$__reply" | tr '[:upper:]' '[:lower:]') in
    y|yes|"") return 0 ;;
    *) return 1 ;;
  esac
}

# GitHub App and installation IDs are numeric. Re-prompt (or die when
# non-interactive) instead of writing a name/slug that fails at the first
# GitHub API call. Usage: prompt_digits VAR REQUIRED(0|1) MSG [DEFAULT]
prompt_digits() {
  local __var=$1 __required=$2
  local __value
  shift 2
  while true; do
    prompt "$__var" "$@"
    __value="${!__var:-}"
    if [[ "$__value" =~ ^[0-9]+$ || ( "$__required" != "1" && -z "$__value" ) ]]; then
      return 0
    fi
    if [[ "$NON_INTERACTIVE" == "1" ]]; then
      die "$__var must be the numeric ID (digits only), not the app name or slug — got '${__value}'"
    fi
    echo "Enter the numeric ID (digits only), not the app name or slug." > /dev/tty 2>/dev/null || echo "Enter the numeric ID (digits only), not the app name or slug."
    printf -v "$__var" '%s' ""
  done
}

expand_path() {
  local p=$1
  case "$p" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s\n' "$HOME/${p#~/}" ;;
    *) printf '%s\n' "$p" ;;
  esac
}

env_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/\\$/g'
}

upsert_env() {
  local file=$1 key=$2 value=$3
  local line="${key}=\"$(env_escape "$value")\""
  local tmp
  tmp=$(mktemp)
  awk -v key="$key" -v line="$line" '
    BEGIN { done = 0 }
    {
      pat = "^[# ]*" key "="
      if ($0 ~ pat) {
        if (!done) { print line; done = 1 }
        next
      }
      print
    }
    END { if (!done) print line }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

load_env_value() {
  local file=$1 key=$2
  [[ -f "$file" ]] || return 0
  local line
  line=$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 || true)
  [[ -n "$line" ]] || return 0
  local val=${line#*=}
  val=${val#\"}
  val=${val%\"}
  val=${val#\'}
  val=${val%\'}
  printf '%s' "$val"
}

# node:22-bookworm-slim USER node is uid 1000 / gid 1000. Compose bind-mounts
# github-app.pem :ro, which preserves host ownership and mode — the file must
# be readable by uid 1000 or the container fails closed ("PRIVATE_KEY_FILE is
# unreadable"). chown needs root, so on a non-root install fall back to an ACL
# grant, then to other-read with a loud warning.
secure_key_file() {
  local dest=$1
  local name
  name=$(basename "$dest")
  if chown 1000:1000 "$dest" 2>/dev/null; then
    chmod 400 "$dest"
    return 0
  fi
  if command -v setfacl >/dev/null 2>&1 && setfacl -m u:1000:r "$dest" 2>/dev/null; then
    chmod 600 "$dest"
    log "Could not chown $name to 1000:1000; granted container uid 1000 read via ACL"
    return 0
  fi
  chmod 404 "$dest"
  echo "install.sh: could not chown $name to 1000:1000 (container USER node) and setfacl" >&2
  echo "install.sh: is unavailable — set mode 404 (other-read) so the container can read it." >&2
  echo "install.sh: To tighten again: sudo chown 1000:1000 $name && chmod 400 $name" >&2
}

write_key_file() {
  local dest=$1 src=$2 pem_contents=$3
  if [[ -n "$src" ]]; then
    src=$(expand_path "$src")
    [[ -f "$src" ]] || die "GitHub App private key not found: $src"
    cp "$src" "$dest"
  elif [[ -n "$pem_contents" ]]; then
    printf '%s' "$pem_contents" | sed 's/\\n/\n/g' > "$dest"
    if [[ -s "$dest" ]] && ! grep -q $'\n' "$dest"; then
      # single-line PEM with literal \n already expanded by sed; ensure trailing newline
      printf '\n' >> "$dest"
    fi
  else
    die "Provide ERU_GITHUB_APP_PRIVATE_KEY_PATH or ERU_GITHUB_APP_PRIVATE_KEY"
  fi
  if ! grep -q "BEGIN .*PRIVATE KEY" "$dest"; then
    die "github-app.pem does not look like a PEM private key"
  fi
  secure_key_file "$dest"
}

write_override() {
  cat > "$ROOT/docker-compose.override.yml" <<'EOF'
# Generated by scripts/install.sh. Local bind mounts; do not commit.
# :Z relabels the PEM for this container only — required on SELinux hosts,
# where an unlabeled :ro mount fails with "PRIVATE_KEY_FILE is unreadable".
services:
  eru:
    volumes:
      - ./github-app.pem:/run/secrets/github-app.pem:ro,Z
EOF
}

opencode_filename() {
  local arch extra=""
  arch=$(docker info --format '{{.Architecture}}' 2>/dev/null || uname -m)
  case "$arch" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "Unsupported Docker architecture: $arch" ;;
  esac
  if [[ "$arch" == "x64" ]] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then
    extra="-baseline"
  fi
  printf '%s\n' "opencode-linux-${arch}${extra}.tar.gz"
}

# The service runs read-only as uid 1000, so the seed container runs as root on
# the named volume and hands ownership back. XDG_DATA_HOME is overridden to
# /tmp so `opencode --version` cannot create root-owned dirs on the eru-data
# volume (they would deny the app writes to auth.json later); the final chown
# of /data is a catch-all for anything the root run did touch.
seed_opencode() {
  need_cmd curl
  need_cmd tar
  local filename url tmp ver=""
  filename=$(opencode_filename)
  if [[ -n "${ERU_OPENCODE_VERSION:-}" ]]; then
    ver="${ERU_OPENCODE_VERSION#v}"
    url="https://github.com/anomalyco/opencode/releases/download/v${ver}/${filename}"
  else
    url="https://github.com/anomalyco/opencode/releases/latest/download/${filename}"
  fi
  tmp=$(mktemp -d)
  log "Downloading OpenCode into the eru-opencode volume ($filename)"
  curl -fsSL --connect-timeout 20 --max-time 180 -o "$tmp/$filename" "$url" \
    || die "Failed to download OpenCode from $url"
  tar -xzf "$tmp/$filename" -C "$tmp"
  [[ -f "$tmp/opencode" ]] || die "OpenCode archive did not contain an 'opencode' binary"
  chmod 755 "$tmp/opencode"
  docker compose build
  docker compose run -T --rm --no-deps --user root \
    -v "$tmp/opencode:/tmp/opencode-bin:ro" \
    --entrypoint sh eru -c \
    'mkdir -p /opt/opencode/.opencode/bin && cp /tmp/opencode-bin /opt/opencode/.opencode/bin/opencode && chmod 755 /opt/opencode/.opencode/bin/opencode && HOME=/tmp XDG_DATA_HOME=/tmp/xdg /opt/opencode/.opencode/bin/opencode --version && chown -R 1000:1000 /opt/opencode /data'
  rm -rf "$tmp"
}

wait_health() {
  local port=$1
  local i=0
  local max=90
  log "Waiting for http://127.0.0.1:${port}/health"
  while [[ $i -lt $max ]]; do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
        log "Health check passed"
        return 0
      fi
    else
      if docker compose exec -T eru node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
        log "Health check passed"
        return 0
      fi
    fi
    i=$((i + 1))
    sleep 2
  done
  echo "Timed out waiting for /health. Recent logs:" >&2
  docker compose logs --tail 120 >&2 || true
  return 1
}

ensure_checkout() {
  if is_eru_checkout "$PWD"; then
    ROOT=$PWD
    log "Using checkout $ROOT"
    return 0
  fi

  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    local script_dir candidate
    script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    candidate=$(cd "$script_dir/.." && pwd)
    if is_eru_checkout "$candidate"; then
      ROOT=$candidate
      log "Using checkout $ROOT"
      return 0
    fi
  fi

  need_cmd git
  ROOT=$DEFAULT_HOME
  if [[ -d "$ROOT/.git" ]] && is_eru_checkout "$ROOT"; then
    log "Updating $ROOT ($REPO_REF)"
    git -C "$ROOT" fetch --depth 1 origin "$REPO_REF"
    git -C "$ROOT" checkout "$REPO_REF"
    git -C "$ROOT" pull --ff-only origin "$REPO_REF" || true
    return 0
  fi
  if [[ -e "$ROOT" && ! -d "$ROOT/.git" ]]; then
    die "$ROOT exists and is not an Eru git checkout. Set ERU_HOME or run from a clone."
  fi
  log "Cloning $REPO_URL ($REPO_REF) into $ROOT"
  mkdir -p "$(dirname "$ROOT")"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$ROOT"
}

for _arg in "$@"; do
  case "$_arg" in
    -h|--help) usage; exit 0 ;;
  esac
done

ensure_checkout
cd "$ROOT"

self_is_checkout_script=0
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  self_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [[ "$self_dir" == "$(cd "$ROOT/scripts" && pwd)" ]]; then
    self_is_checkout_script=1
  fi
fi
if [[ "$self_is_checkout_script" != "1" ]]; then
  exec bash "$ROOT/scripts/install.sh" "$@"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive|-y) NON_INTERACTIVE=1; shift ;;
    --skip-start) SKIP_START=1; shift ;;
    --upgrade-opencode) UPGRADE_OPENCODE=1; shift ;;
    --force) FORCE_ENV=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

if [[ "$SKIP_START" != "1" || "$UPGRADE_OPENCODE" == "1" ]]; then
  need_cmd docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)"
  docker info >/dev/null 2>&1 || die "Docker daemon is not running, or this user cannot access it"
fi

if [[ "$UPGRADE_OPENCODE" == "1" ]]; then
  [[ -f "$ROOT/.env" ]] || die "No .env yet; run the installer without --upgrade-opencode first"
  ERU_OPENCODE_VERSION="${ERU_OPENCODE_VERSION:-$(load_env_value "$ROOT/.env" ERU_OPENCODE_VERSION)}"
  seed_opencode
  docker compose up -d --force-recreate
  upgrade_port=$(load_env_value "$ROOT/.env" ERU_PORT)
  wait_health "${upgrade_port:-3000}"
  log "OpenCode reinstall finished. Confirm with: docker compose logs eru | grep -i opencode"
  exit 0
fi

ERU_GITHUB_APP_ID="${ERU_GITHUB_APP_ID:-$(load_env_value "$ROOT/.env" ERU_GITHUB_APP_ID)}"
ERU_GITHUB_APP_INSTALLATION_ID="${ERU_GITHUB_APP_INSTALLATION_ID:-$(load_env_value "$ROOT/.env" ERU_GITHUB_APP_INSTALLATION_ID)}"
ERU_GITHUB_APP_PRIVATE_KEY_PATH="${ERU_GITHUB_APP_PRIVATE_KEY_PATH:-}"
ERU_GITHUB_APP_PRIVATE_KEY="${ERU_GITHUB_APP_PRIVATE_KEY:-}"
ERU_UI_PASSWORD="${ERU_UI_PASSWORD:-$(load_env_value "$ROOT/.env" ERU_UI_PASSWORD)}"
ERU_UI_SESSION_SECRET="${ERU_UI_SESSION_SECRET:-$(load_env_value "$ROOT/.env" ERU_UI_SESSION_SECRET)}"
ERU_FORGE_TOKEN_KEY="${ERU_FORGE_TOKEN_KEY:-$(load_env_value "$ROOT/.env" ERU_FORGE_TOKEN_KEY)}"
ERU_UI_USER="${ERU_UI_USER:-$(load_env_value "$ROOT/.env" ERU_UI_USER)}"
ERU_OPENCODE_MODEL="${ERU_OPENCODE_MODEL:-$(load_env_value "$ROOT/.env" ERU_OPENCODE_MODEL)}"
ERU_OPENCODE_VERSION="${ERU_OPENCODE_VERSION:-$(load_env_value "$ROOT/.env" ERU_OPENCODE_VERSION)}"
ERU_PORT="${ERU_PORT:-$(load_env_value "$ROOT/.env" ERU_PORT)}"
ERU_PORT="${ERU_PORT:-3000}"
ERU_PUBLIC_URL="${ERU_PUBLIC_URL:-}"

if [[ -f "$ROOT/.env" && "$FORCE_ENV" != "1" ]]; then
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    REUSE_ENV=1
    log "Reusing existing $ROOT/.env (pass --force to overwrite)"
  elif confirm "Found $ROOT/.env. Reuse it without rewriting" Y; then
    REUSE_ENV=1
  fi
fi

app_configured=0

if [[ "$REUSE_ENV" != "1" ]]; then
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    if [[ -n "$ERU_GITHUB_APP_ID" ]]; then
      [[ "$ERU_GITHUB_APP_ID" =~ ^[0-9]+$ ]] || \
        die "ERU_GITHUB_APP_ID must be the numeric App ID (digits only, e.g. 123456), not the app name or slug"
      [[ -z "$ERU_GITHUB_APP_INSTALLATION_ID" || "$ERU_GITHUB_APP_INSTALLATION_ID" =~ ^[0-9]+$ ]] || \
        die "ERU_GITHUB_APP_INSTALLATION_ID must be numeric (digits only)"
      if [[ -z "$ERU_GITHUB_APP_PRIVATE_KEY" && -z "$ERU_GITHUB_APP_PRIVATE_KEY_PATH" && -f "$ROOT/github-app.pem" ]]; then
        ERU_GITHUB_APP_PRIVATE_KEY_PATH="$ROOT/github-app.pem"
      fi
      [[ -n "$ERU_GITHUB_APP_PRIVATE_KEY" || -n "$ERU_GITHUB_APP_PRIVATE_KEY_PATH" ]] || \
        die "ERU_GITHUB_APP_ID is set but no ERU_GITHUB_APP_PRIVATE_KEY_PATH / ERU_GITHUB_APP_PRIVATE_KEY given"
      app_configured=1
    fi
  elif confirm "Configure a GitHub App? (enables repo pick-list on /connect)" N; then
    cat <<'EOF'

Create the GitHub App first if you have not (least privilege — Eru only reads):
  Metadata: Read
  Contents: Read
This installer does not create the App. The PEM is copied to github-app.pem and
bind-mounted read-only; it is never written to .env or baked into the image.

EOF
    prompt_digits ERU_GITHUB_APP_ID 1 "GitHub App ID (numeric)"
    prompt_digits ERU_GITHUB_APP_INSTALLATION_ID 0 "Installation ID (empty = auto-detect single install)"
    if [[ -z "$ERU_GITHUB_APP_PRIVATE_KEY_PATH" && -z "$ERU_GITHUB_APP_PRIVATE_KEY" && -f "$ROOT/github-app.pem" ]]; then
      ERU_GITHUB_APP_PRIVATE_KEY_PATH="$ROOT/github-app.pem"
    fi
    if [[ -z "$ERU_GITHUB_APP_PRIVATE_KEY" ]]; then
      prompt_required ERU_GITHUB_APP_PRIVATE_KEY_PATH "Path to GitHub App private key (.pem)"
    fi
    app_configured=1
  fi

  generated_password=0
  prompt ERU_UI_PASSWORD "UI password (empty = generate)"
  if [[ -z "$ERU_UI_PASSWORD" ]]; then
    ERU_UI_PASSWORD=$(rand_hex 16)
    generated_password=1
  fi
  if [[ -z "$ERU_UI_SESSION_SECRET" ]]; then
    ERU_UI_SESSION_SECRET=$(rand_hex 32)
  fi
  prompt ERU_UI_SESSION_SECRET "UI session secret (empty = keep generated)"
  if [[ -z "$ERU_FORGE_TOKEN_KEY" ]]; then
    ERU_FORGE_TOKEN_KEY=$(rand_hex 32)
  fi

  prompt ERU_UI_USER "GitHub login for the top bar (empty = operator monogram)"
  prompt ERU_OPENCODE_MODEL "Default OpenCode model (provider/model, empty = decide on /config)"
  prompt ERU_OPENCODE_VERSION "Pin OpenCode CLI version (empty = latest GitHub release)"
  prompt ERU_PORT "Host port" "$ERU_PORT"
  prompt ERU_PUBLIC_URL "Public base URL (only for the printed summary)" "http://127.0.0.1:${ERU_PORT}"

  cp "$ROOT/.env.example" "$ROOT/.env"
  upsert_env "$ROOT/.env" ERU_HOST "0.0.0.0"
  upsert_env "$ROOT/.env" ERU_PORT "$ERU_PORT"
  upsert_env "$ROOT/.env" ERU_SQLITE_PATH "/data/eru.sqlite"
  upsert_env "$ROOT/.env" ERU_UI_PASSWORD "$ERU_UI_PASSWORD"
  upsert_env "$ROOT/.env" ERU_UI_SESSION_SECRET "$ERU_UI_SESSION_SECRET"
  upsert_env "$ROOT/.env" ERU_FORGE_TOKEN_KEY "$ERU_FORGE_TOKEN_KEY"
  upsert_env "$ROOT/.env" ERU_OPENCODE_BIN "/opt/opencode/.opencode/bin/opencode"
  if [[ -n "$ERU_UI_USER" ]]; then
    upsert_env "$ROOT/.env" ERU_UI_USER "$ERU_UI_USER"
  fi
  if [[ -n "$ERU_OPENCODE_MODEL" ]]; then
    upsert_env "$ROOT/.env" ERU_OPENCODE_MODEL "$ERU_OPENCODE_MODEL"
  fi
  if [[ -n "$ERU_OPENCODE_VERSION" ]]; then
    upsert_env "$ROOT/.env" ERU_OPENCODE_VERSION "$ERU_OPENCODE_VERSION"
  fi

  if [[ "$app_configured" == "1" ]]; then
    upsert_env "$ROOT/.env" ERU_GITHUB_APP_ID "$ERU_GITHUB_APP_ID"
    upsert_env "$ROOT/.env" ERU_GITHUB_APP_PRIVATE_KEY ""
    upsert_env "$ROOT/.env" ERU_GITHUB_APP_PRIVATE_KEY_FILE "/run/secrets/github-app.pem"
    if [[ -n "$ERU_GITHUB_APP_INSTALLATION_ID" ]]; then
      upsert_env "$ROOT/.env" ERU_GITHUB_APP_INSTALLATION_ID "$ERU_GITHUB_APP_INSTALLATION_ID"
    fi
  fi

  chmod 600 "$ROOT/.env"
  if [[ "$app_configured" == "1" ]]; then
    write_key_file "$ROOT/github-app.pem" "$ERU_GITHUB_APP_PRIVATE_KEY_PATH" "$ERU_GITHUB_APP_PRIVATE_KEY"
    write_override
    log "Wrote $ROOT/.env (mode 600) and $ROOT/github-app.pem (mode 400, uid 1000 when chown succeeds)"
  else
    rm -f "$ROOT/docker-compose.override.yml"
    log "Wrote $ROOT/.env (mode 600); no GitHub App configured — connect repos with a token or set the App up on /config later"
  fi
  if [[ "$generated_password" == "1" ]]; then
    echo
    echo "Generated UI password (save this; it is also in .env): $ERU_UI_PASSWORD"
    echo
  fi
else
  app_id_env=$(load_env_value "$ROOT/.env" ERU_GITHUB_APP_ID)
  if [[ -n "$app_id_env" ]]; then
    [[ "$app_id_env" =~ ^[0-9]+$ ]] || \
      die ".env ERU_GITHUB_APP_ID must be the numeric App ID (digits only, e.g. 123456), not the app name or slug"
    inst_id_env=$(load_env_value "$ROOT/.env" ERU_GITHUB_APP_INSTALLATION_ID)
    [[ -z "$inst_id_env" || "$inst_id_env" =~ ^[0-9]+$ ]] || \
      die ".env ERU_GITHUB_APP_INSTALLATION_ID must be numeric (digits only)"
    [[ -f "$ROOT/github-app.pem" ]] || die ".env sets ERU_GITHUB_APP_ID but $ROOT/github-app.pem is missing"
    secure_key_file "$ROOT/github-app.pem"
    [[ -f "$ROOT/docker-compose.override.yml" ]] || write_override
    app_configured=1
  fi
  ERU_PORT=$(load_env_value "$ROOT/.env" ERU_PORT)
  ERU_PORT=${ERU_PORT:-3000}
  ERU_PUBLIC_URL=$(load_env_value "$ROOT/.env" ERU_PUBLIC_URL)
  ERU_UI_PASSWORD=$(load_env_value "$ROOT/.env" ERU_UI_PASSWORD)
fi

ERU_PUBLIC_URL="${ERU_PUBLIC_URL:-http://127.0.0.1:${ERU_PORT}}"

if [[ "$SKIP_START" == "1" ]]; then
  log "Skipping docker compose (--skip-start)"
  echo "Next: cd $ROOT && ./scripts/install.sh --upgrade-opencode"
  echo "(seeds OpenCode from GitHub releases, then starts Compose;"
  echo " bare docker compose up with an empty eru-opencode volume fails closed)"
  exit 0
fi

log "Building Eru and seeding OpenCode into volume eru-opencode"
export ERU_PORT
seed_opencode
if [[ "$app_configured" == "1" ]]; then
  # Fail fast with remediation instead of the app's "PRIVATE_KEY_FILE is
  # unreadable" crash: exercise the exact mount + uid the service uses.
  if ! docker compose run -T --rm --no-deps --entrypoint sh eru -c 'test -r /run/secrets/github-app.pem'; then
    die "github-app.pem is unreadable inside the container (uid 1000).
  Fix on this host: sudo chown 1000:1000 $ROOT/github-app.pem && chmod 400 $ROOT/github-app.pem
  (or: setfacl -m u:1000:r $ROOT/github-app.pem) then re-run this installer."
  fi
fi
docker compose up -d
wait_health "$ERU_PORT"

cat <<EOF

Eru is up.

  UI:      ${ERU_PUBLIC_URL}/
  Health:  ${ERU_PUBLIC_URL}/health
  Config:  ${ERU_PUBLIC_URL}/config   (models, provider API keys, GitHub App)

Provider API keys live in OpenCode's auth.json — save them on /config; they are
never written to .env or the eru database. Data lives in Docker volumes:

  eru-data      → /data          (SQLite + OpenCode auth.json under xdg/)
  eru-opencode  → /opt/opencode  (OpenCode CLI)

Secrets: $ROOT/.env$( [[ "$app_configured" == "1" ]] && echo " and $ROOT/github-app.pem" ) (not baked into the image).
Upgrade Eru:  git pull && docker compose up -d --build
Upgrade OpenCode only:  ./scripts/install.sh --upgrade-opencode

EOF
