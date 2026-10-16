#!/usr/bin/env bash
# Builds the web-3d-builder package for macOS (native arch: arm64 or x86_64).
# Produces dist/web-3d-builder-macos.zip containing a self-contained app folder.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${1:-$ROOT/.venv}"
PY="$VENV/bin/python"
DIST="$ROOT/dist"
PKG="web3dbuilder"

echo "==> Using Python: $("$PY" --version)"
"$PY" -m pip install --quiet pyinstaller waitress >/dev/null

# 1. Main executable (onedir, console so the terminal window stays visible)
echo "==> Building main executable ($PKG)"
rm -rf "$DIST/$PKG" "$ROOT/build_main"
"$PY" -m PyInstaller \
    --name "$PKG" --onedir --console \
    --hidden-import gunicorn.glogging \
    --hidden-import gunicorn.arbiter \
    --hidden-import gunicorn.workers.sync \
    --distpath "$DIST" --workpath "$ROOT/build_main" \
    run.py

# 2. AI companion (onefile, self-contained: bundles build123d + llama-cpp)
echo "==> Building AI runner (run_agent)"
rm -f "$DIST/run_agent"
"$PY" -m PyInstaller \
    --name run_agent --onefile \
    --distpath "$DIST" --workpath "$ROOT/build_agent" \
    ai/run_agent.py

# 3. Assemble runtime data next to the executable (only what the app uses)
echo "==> Assembling package data"
D="$DIST/$PKG"
rm -rf "$D/static" "$D/templates" "$D/.config" "$D/ai"
cp -R "$ROOT/static"     "$D/static"
cp -R "$ROOT/templates"  "$D/templates"
cp    "$ROOT/.config"    "$D/.config"
mkdir -p "$D/ai/input" "$D/ai/output"
cp -R "$ROOT/ai/prompts" "$D/ai/prompts"
cp -R "$ROOT/ai/models"  "$D/ai/models"

# 4. Drop the AI runner into the bundle (the main app invokes it as a sibling)
mv "$DIST/run_agent" "$D/run_agent"
chmod +x "$D/$PKG" "$D/run_agent"

# 5. Strip OS junk so only essential files ship
find "$D" -name ".DS_Store" -delete 2>/dev/null || true
find "$D" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

# 6. Zip the folder
echo "==> Creating zip"
cd "$DIST" && rm -f web-3d-builder-macos.zip
zip -r -q web-3d-builder-macos.zip "$PKG" >/dev/null
echo "Done: $DIST/web-3d-builder-macos.zip"
