#!/bin/sh
# The core's entrypoint: install the transport packages the operator named,
# apply pending migrations, serve.
#
# TRANSPORTS is a space-separated list of npm package specs — a name, a name
# with a version, or a path to a tarball mounted into the container:
#
#   TRANSPORTS="@assistants-swarm-hub/ash-transport-telegram@1.3.0 /packs/ash-transport-discord-1.2.0.tgz"
#
# They are installed into /app/transports, a directory of its own with a
# manifest of its own — the manifest matters: without one npm walks up, takes
# /app for the project root, and prunes the traced node_modules the server
# runs on as extraneous. With it, npm resolves exactly what was asked for and
# stops there. The host finds the packages through NODE_PATH, the way Node's
# own resolver would. Nothing is cached across
# container recreations: an install happens on every boot that names
# transports, which is what keeps "which version runs" a fact of the
# environment rather than of a layer.
#
# NPM_TOKEN authenticates the org's registry on GitHub Packages, which wants a
# token even for a public package. It is written to a temporary .npmrc for
# the install and removed before the server starts; it never reaches the
# process environment the app runs with.
set -eu

if [ -n "${TRANSPORTS:-}" ]; then
  echo "installing transport packages: $TRANSPORTS"
  mkdir -p /app/transports
  # The manifest that makes /app/transports npm's project root (see above).
  [ -f /app/transports/package.json ] ||
    printf '{ "name": "transports", "private": true }\n' > /app/transports/package.json
  npmrc=/app/transports/.npmrc
  printf '@assistants-swarm-hub:registry=https://npm.pkg.github.com\n' > "$npmrc"
  if [ -n "${NPM_TOKEN:-}" ]; then
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$NPM_TOKEN" >> "$npmrc"
  fi
  # The list is meant to split on spaces.
  # shellcheck disable=SC2086
  if ! (cd /app/transports && npm install --no-save --no-package-lock --omit=dev \
        --no-audit --no-fund --userconfig "$npmrc" $TRANSPORTS); then
    echo "transport packages could not be installed; the core starts without them" >&2
  fi
  rm -f "$npmrc"
  export NODE_PATH="/app/transports/node_modules${NODE_PATH:+:$NODE_PATH}"
fi
unset NPM_TOKEN

# Apply pending migrations, then serve. Migrations complete before the app
# accepts traffic; a failed migration fails the start.
node migrate/migrate.mjs
exec node core/server.js
