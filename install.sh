#!/usr/bin/env bash
# rulepress installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/TuanCui22/rulepress/master/install.sh | bash
#
# or from a clone:
#
#   ./install.sh
#
# Installs rulepress globally with npm so the `rulepress` command works from
# anywhere. Falls back to a local npm link if the global prefix is not writable.

set -euo pipefail

MIN_NODE=18
REPO_URL="https://github.com/TuanCui22/rulepress.git"

# ---- pretty output -------------------------------------------------------
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD=$(tput bold); DIM=$(tput dim); RED=$(tput setaf 1); GREEN=$(tput setaf 2)
  YELLOW=$(tput setaf 3); RESET=$(tput sgr0)
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

info()  { printf '%s\n' "  $*"; }
ok()    { printf '%s\n' "  ${GREEN}✓${RESET} $*"; }
warn()  { printf '%s\n' "  ${YELLOW}!${RESET} $*"; }
die()   { printf '%s\n' "  ${RED}✗${RESET} $*" >&2; exit 1; }

printf '\n%s\n' "${BOLD}rulepress installer${RESET}"
printf '%s\n\n' "${DIM}Elastic detection-rule TOML → Kibana NDJSON${RESET}"

# ---- 1. Node present and new enough -------------------------------------
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "  ${RED}✗${RESET} Node.js is not installed."
  printf '\n'
  printf '%s\n' "  Install Node ${MIN_NODE} or newer:"
  printf '%s\n' "    https://nodejs.org  (choose LTS)"
  printf '%s\n' "    or:  curl -fsSL https://fnm.vercel.app/install | bash && fnm install ${MIN_NODE}"
  printf '\n'
  exit 1
fi

NODE_VERSION=$(node --version)
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)

if [ "$NODE_MAJOR" -lt "$MIN_NODE" ]; then
  printf '%s\n' "  ${RED}✗${RESET} Node $NODE_VERSION is too old. rulepress needs ${MIN_NODE}+."
  printf '\n'
  printf '%s\n' "  Upgrade with one of:"
  printf '%s\n' "    nvm install ${MIN_NODE} && nvm use ${MIN_NODE}"
  printf '%s\n' "    fnm install ${MIN_NODE} && fnm use ${MIN_NODE}"
  printf '%s\n' "    or download from https://nodejs.org"
  printf '\n'
  exit 1
fi
ok "Node $NODE_VERSION"

# ---- 2. npm present ------------------------------------------------------
command -v npm >/dev/null 2>&1 || die "npm not found. It ships with Node; reinstall Node from https://nodejs.org"
ok "npm $(npm --version)"

# ---- 3. locate the package ----------------------------------------------
# If this script sits next to package.json we are in a clone; otherwise fetch.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd || echo "")
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  PKG_DIR="$SCRIPT_DIR"
  ok "using local checkout: $PKG_DIR"
else
  TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t rulepress)
  trap 'rm -rf "$TMP_DIR"' EXIT
  info "downloading source…"
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 "$REPO_URL" "$TMP_DIR/rulepress" >/dev/null 2>&1 \
      || die "git clone failed. Check your network, or download the repo manually."
  else
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "https://github.com/TuanCui22/rulepress/archive/refs/heads/master.tar.gz" \
        | tar -xz -C "$TMP_DIR" \
        || die "download failed. Install git or curl and retry."
    else
      die "need git or curl to download rulepress."
    fi
    mv "$TMP_DIR"/rulepress-* "$TMP_DIR/rulepress" 2>/dev/null || true
  fi
  PKG_DIR="$TMP_DIR/rulepress"
  [ -f "$PKG_DIR/package.json" ] || die "download did not produce a package. Aborting."
  ok "downloaded"
fi

# ---- 4. install dependencies --------------------------------------------
info "installing dependencies…"
(cd "$PKG_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1) \
  || die "npm install failed inside $PKG_DIR"
ok "dependencies installed"

# ---- 5. link the command -------------------------------------------------
info "installing the rulepress command…"
if (cd "$PKG_DIR" && npm install -g . --no-audit --no-fund >/dev/null 2>&1); then
  ok "installed globally"
else
  warn "global install needs elevated permissions; linking locally instead"
  if (cd "$PKG_DIR" && npm link >/dev/null 2>&1); then
    ok "linked with npm link"
  else
    warn "could not link. You can still run it directly:"
    printf '%s\n' "      node \"$PKG_DIR/bin/rulepress.js\" --help"
  fi
fi

# ---- 6. verify -----------------------------------------------------------
printf '\n'
if command -v rulepress >/dev/null 2>&1; then
  VERSION=$(rulepress --version 2>/dev/null || echo "?")
  ok "rulepress $VERSION is on your PATH"
  printf '\n%s\n' "${BOLD}Try it:${RESET}"
  printf '%s\n' "    rulepress --help"
  printf '%s\n' "    rulepress /path/to/elastic-rules/rules --bundle rules.ndjson"
  printf '\n%s\n' "${DIM}Then: Kibana → Security → Detection rules → Import → rules.ndjson${RESET}"
else
  warn "rulepress is installed but not on your PATH."
  printf '%s\n' "  Add npm's global bin directory to PATH:"
  printf '%s\n' "    echo 'export PATH=\"\$(npm prefix -g)/bin:\$PATH\"' >> ~/.bashrc"
  printf '%s\n' "    source ~/.bashrc"
fi
printf '\n'
