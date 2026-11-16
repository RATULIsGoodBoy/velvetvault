#!/usr/bin/env bash
# ==============================================================================
# VelvetVault — Automated Termux Setup Script for Android
# ==============================================================================

set -e

echo ""
echo "✨ ====================================================="
echo "✨   VELVETVAULT — ANDROID (TERMUX) INSTALLER"
echo "✨ ====================================================="
echo ""

# 1. Verify Termux environment
if [ -z "$TERMUX_VERSION" ] && [ ! -d "/data/data/com.termux" ]; then
  echo "⚠️ Warning: This script is optimized for Android Termux."
fi

# 2. Update packages and install prerequisites
echo "📦 Step 1/5: Upgrading packages & installing prerequisites (libc++, Node.js, OpenSSH, Cloudflare Tunnel, Termux API)..."
pkg update -y
pkg upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" || true
pkg install -y libc++ openssh termux-api cloudflared || pkg install -y libc++ openssh termux-api
pkg install -y nodejs-lts || pkg install -y nodejs

# Verify cloudflared or fetch binary
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "🌐 Downloading Cloudflare Quick Tunnel binary for Android..."
  ARCH=$(uname -m)
  mkdir -p "$DIR/bin"
  if [ "$ARCH" = "aarch64" ]; then
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" -o "$DIR/bin/cloudflared" || true
    chmod +x "$DIR/bin/cloudflared" 2>/dev/null || true
  fi
fi

# 3. Setup Android Storage Permissions
echo ""
echo "📱 Step 2/5: Setting up Android Gallery storage access..."
if command -v termux-setup-storage >/dev/null 2>&1; then
  termux-setup-storage || true
  sleep 2
fi

# Ensure Pictures/Vault directory exists on Android phone
mkdir -p ~/storage/shared/Pictures/Vault 2>/dev/null || true
mkdir -p ~/storage/pictures/Vault 2>/dev/null || true
mkdir -p /sdcard/Pictures/Vault 2>/dev/null || true

# 4. Install Node dependencies
echo ""
echo "📦 Step 3/5: Installing VelvetVault dependencies..."
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
npm install --no-audit --no-fund

# 5. Make executable & register global 'vault' command
echo ""
echo "⚡ Step 4/5: Registering global 'vault' command..."
chmod +x "$DIR/vault.sh" "$DIR/src/cli.mjs"

TARGET_BIN="${PREFIX:-/usr/local}/bin"
mkdir -p "$TARGET_BIN" 2>/dev/null || true
ln -sf "$DIR/vault.sh" "$TARGET_BIN/vault"
ln -sf "$DIR/vault.sh" "$TARGET_BIN/vault.sh"

# 6. Optional: Setup Android Home Screen Widget (Termux:Widget)
echo ""
echo "📱 Step 5/5: Configuring Android 1-Tap Home Screen Shortcuts..."
SHORTCUTS_DIR="$HOME/.shortcuts"
mkdir -p "$SHORTCUTS_DIR"

cat << 'EOF' > "$SHORTCUTS_DIR/Open_Vault_20m.sh"
#!/usr/bin/env bash
vault open 20m ~/storage/shared/Pictures/Vault --no-encrypt
EOF
chmod +x "$SHORTCUTS_DIR/Open_Vault_20m.sh"

cat << 'EOF' > "$SHORTCUTS_DIR/Open_Vault_1h.sh"
#!/usr/bin/env bash
vault open 1h ~/storage/shared/Pictures/Vault --no-encrypt
EOF
chmod +x "$SHORTCUTS_DIR/Open_Vault_1h.sh"

cat << 'EOF' > "$SHORTCUTS_DIR/Close_Vault.sh"
#!/usr/bin/env bash
vault close
EOF
chmod +x "$SHORTCUTS_DIR/Close_Vault.sh"

echo ""
echo "🎉 ====================================================="
echo "🎉   INSTALLATION COMPLETE! VELVETVAULT IS READY."
echo "🎉 ====================================================="
echo ""
echo "🚀 Quick Commands in Termux:"
echo "   vault open 20m               (Start a 20-minute drop window)"
echo "   vault open 1h --no-encrypt   (Save directly to phone's Pictures/Vault)"
echo "   vault open forever           (Keep open until you close it)"
echo "   vault portal                 (Open Host Control in phone browser)"
echo "   vault close                  (Stop session immediately)"
echo ""
echo "📱 Home Screen Widget (Termux:Widget):"
echo "   Shortcuts have been created in ~/.shortcuts/"
echo "   You can add a widget on your phone's home screen for 1-tap vault!"
echo ""
