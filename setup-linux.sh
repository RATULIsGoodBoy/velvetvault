#!/usr/bin/env bash
# VelvetVault — Linux PC Installer
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "📦 Installing VelvetVault dependencies..."
npm install

echo "⚡ Registering global 'vault' command..."
chmod +x "$DIR/vault.sh" "$DIR/src/cli.mjs"

TARGET_BIN="$HOME/.local/bin"
mkdir -p "$TARGET_BIN"
ln -sf "$DIR/vault.sh" "$TARGET_BIN/vault"
ln -sf "$DIR/vault.sh" "$TARGET_BIN/vault.sh"

echo "✅ VelvetVault installed successfully! Run 'vault open 20m' from anywhere."
