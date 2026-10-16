# Builds the web-3d-builder package for Windows (run on a Windows machine).
# Produces dist\web-3d-builder-windows.zip containing a self-contained app folder.
# Usage:  powershell -ExecutionPolicy Bypass -File packaging\build_windows.ps1 [-Venv .\.venv]
param([string]$Venv = ".\.venv")

$ErrorActionPreference = "Stop"
$Root   = Split-Path -Parent $PSScriptRoot
$Py     = Join-Path $Venv "Scripts\python.exe"
$Dist   = Join-Path $Root "dist"
$PkG    = "web3dbuilder"

Write-Host "==> Using Python: $((& $Py --version) 2>&1 | Out-String)"
& $Py -m pip install --quiet pyinstaller waitress | Out-Null

# 1. Main executable (onedir, console so the terminal window stays visible)
Write-Host "==> Building main executable ($PkG.exe)"
Remove-Item -Recurse -Force "$Dist\$PkG" -ErrorAction SilentlyContinue
& $Py -m PyInstaller `
    --name $PkG --onedir --console `
    --hidden-import gunicorn.glogging `
    --hidden-import gunicorn.arbiter `
    --hidden-import gunicorn.workers.sync `
    --distpath $Dist --workpath (Join-Path $Root "build_main") `
    run.py

# 2. AI companion (onefile, self-contained: bundles build123d + llama-cpp)
Write-Host "==> Building AI runner (run_agent.exe)"
Remove-Item -Force "$Dist\run_agent.exe" -ErrorAction SilentlyContinue
& $Py -m PyInstaller `
    --name run_agent --onefile `
    --distpath $Dist --workpath (Join-Path $Root "build_agent") `
    ai\run_agent.py

# 3. Assemble runtime data files next to the main executable (only what the app uses)
Write-Host "==> Assembling package data"
$D = Join-Path "$Dist" $PkG
Remove-Item -Recurse -Force "$D\static","$D\templates","$D\.config","$D\ai" -ErrorAction SilentlyContinue
Copy-Item -Recurse (Join-Path $Root "static")     "$D\static"
Copy-Item -Recurse (Join-Path $Root "templates")  "$D\templates"
Copy-Item        (Join-Path $Root ".config")      "$D\.config"
New-Item -ItemType Directory -Force -Path "$D\ai\input","$D\ai\output" | Out-Null
Copy-Item -Recurse (Join-Path $Root "ai\prompts") "$D\ai\prompts"
Copy-Item -Recurse (Join-Path $Root "ai\models")  "$D\ai\models"

# 4. Drop the AI runner into the bundle (the main app invokes it as a sibling)
Move-Item "$Dist\run_agent.exe" "$D\run_agent.exe" -Force

# 5. Strip OS junk so only essential files ship
Get-ChildItem -Path $D -Recurse -Force -Include ".DS_Store","Thumbs.db" | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $D -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# 6. Zip the folder
Write-Host "==> Creating zip"
$Zip = Join-Path $Dist "web-3d-builder-windows.zip"
Remove-Item $Zip -ErrorAction SilentlyContinue
Compress-Archive -Path "$D\*" -Destination $Zip
Write-Host "Done: $Zip"
