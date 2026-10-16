#!/usr/bin/env bash
# Builds the web-3d-builder package for Linux inside Docker.
#
# Produces:
#   dist/linux/web3dbuilder/             - self-contained app folder (run ./web3dbuilder)
#   dist/web-3d-builder-linux.AppImage   - portable AppImage        (best-effort, needs FUSE-free tooling)
#   dist/io.github.web3dbuilder.flatpak  - Flatpak                  (needs a flatpak-enabled host/CI)
#
# Usage:
#   ./packaging/build_linux.sh            # build for the docker host arch
#   ./packaging/build_linux.sh x86_64     # force amd64 (uses QEMU emulation on arm hosts - slow)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
PKG="web3dbuilder"
IMAGE="w3b-linux-build:py313"
PLATFORM="${1:-}"            # e.g. x86_64 or aarch64; empty = docker host arch

# --- 0. Build the dependency image (once per target arch) ---------------------
echo "==> Building Docker build-image ($IMAGE)"
docker build -t "$IMAGE" packaging/docker/

DOCKER_PLATFORM_ARGS=()
[ -n "$PLATFORM" ] && DOCKER_PLATFORM_ARGS=(--platform "linux/$PLATFORM")

# --- 1. Build the app bundle inside Docker (reliable core) --------------------
echo "==> Building main + AI executables and assembling the bundle"
rm -rf "$DIST/linux"
mkdir -p "$DIST/linux"
docker run --rm "${DOCKER_PLATFORM_ARGS[@]}" \
    -v "$ROOT":/src -w /src \
    -v "$DIST/linux":/out \
    "$IMAGE" bash -s <<'EOF'
set -euo pipefail

# Main executable (onedir, console so the terminal window stays visible)
python -m PyInstaller --name web3dbuilder --onedir --console \
    --hidden-import gunicorn.glogging \
    --hidden-import gunicorn.arbiter \
    --hidden-import gunicorn.workers.sync \
    --distpath /out --workpath /tmp/build_main run.py

# AI companion (onefile, self-contained: bundles build123d + llama-cpp)
python -m PyInstaller --name run_agent --onefile \
    --distpath /out --workpath /tmp/build_agent ai/run_agent.py

# Assemble runtime data files next to the main executable (only what the app uses)
D=/out/web3dbuilder
rm -rf "$D/static" "$D/templates" "$D/.config" "$D/ai"
cp -R static     "$D/static"
cp -R templates  "$D/templates"
cp    .config    "$D/.config"
mkdir -p "$D/ai/input" "$D/ai/output"
cp -R ai/prompts "$D/ai/prompts"
cp -R ai/models  "$D/ai/models"
mv /out/run_agent "$D/run_agent"
chmod +x "$D/web3dbuilder" "$D/run_agent"

# Strip OS junk so only essential files ship
find "$D" -name ".DS_Store" -delete 2>/dev/null || true
find "$D" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

# AppImage: wrap the onedir bundle with appimagetool (linuxdeploy). Runs without FUSE.
wget -q https://github.com/AppImage/apps/releases/download/v14/appimagetool-x86_64.AppImage \
     -O /tmp/appimagetool.AppImage || true
if [ -f /tmp/appimagetool.AppImage ]; then
    chmod +x /tmp/appimagetool.AppImage
    /tmp/appimagetool.AppImage --appimage-extract >/dev/null 2>&1 || true
    TOOL=/tmp/squashfs-root/usr/bin/appimagetool
    [ -x "$TOOL" ] && "$TOOL" /out/web3dbuilder \
        -i static/img/logo.svg -e web3dbuilder \
        -n io.github.web3dbuilder \
        -d "web-3d-builder: browser-based 3D mesh editor" \
        /out/web-3d-builder-linux.AppImage || echo "AppImage wrap failed (tooling/version); bundle is still valid."
fi
EOF

echo "==> App bundle : $DIST/linux/$PKG/"
[ -f "$DIST/linux/web-3d-builder-linux.AppImage" ] && \
    mv "$DIST/linux/web-3d-builder-linux.AppImage" "$DIST/web-3d-builder-linux.AppImage" && \
    echo "==> AppImage   : $DIST/web-3d-builder-linux.AppImage"

# --- 2. Flatpak (needs a flatpak-enabled host or CI, not a plain container) ---
echo "==> Preparing Flatpak bundle tarball"
tar -C "$DIST/linux" -cJf packaging/flatpak/web3dbuilder-bundle.tar.xz web3dbuilder

if command -v flatpak-builder >/dev/null 2>&1; then
    echo "==> Building Flatpak via flatpak-builder"
    mkdir -p "$DIST/flatpak-build"
    flatpak-builder --user --build-dir="$DIST/flatpak-build" \
        "$DIST/io.github.web3dbuilder.flatpak" \
        packaging/flatpak/io.github.web3dbuilder.yaml
else
    echo "==> Flatpak: 'flatpak-builder' not found on this host."
    echo "    Build it on a flatpak-enabled machine / CI:"
    echo "      flatpak-builder --user -o io.github.web3dbuilder.flatpak \\"
    echo "        packaging/flatpak/io.github.web3dbuilder.yaml"
fi
