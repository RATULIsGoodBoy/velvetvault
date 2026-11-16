#!/usr/bin/env bash
# ==============================================================================
# VelvetVault — Cross-platform executable launcher (Symlink Safe)
# ==============================================================================

# Resolve symlinks to find true repository directory
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"

exec node "$DIR/src/cli.mjs" "$@"
