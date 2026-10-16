<p align="center">
  <img src="static/img/banner.svg" alt="web-3d-builder logo" width="420">
</p>

A browser-based 3D mesh editor: Flask backend, Three.js frontend.

## Features

- Import/export STL, OBJ, PLY, GLB/GLTF, 3MF
- CSG booleans (union, subtract, intersect) via manifold3d
- Geometry operations: solid, hollow, cut, scale, rotate, translate, simplify, smooth, fillet, chamfer
- Primitive solids (box, cylinder, sphere, and more)
- Undo/redo history
- AI text-to-CAD generation with local .gguf models or an OpenAI-compatible API

## Setup

```bash
pip install -r requirements.txt
```

## Run

```bash
python run.py
```

Serves the editor at http://localhost:8181. Host, port, and worker count come from `.config`, then `HOST`/`PORT` env vars, then built-in defaults.

## Docker

Run with docker compose:

```yaml
services: web3dbuilder:
    image: colliboy/3d-over-easy:latest
    ports:
      - "8181:8181"
    restart: unless-stopped
```

Or run the container directly:

```bash
docker run --rm -p 8181:8181 colliboy/3d-over-easy:latest
```

Serves the editor at http://localhost:8181. The image binds all interfaces and skips launching a browser, so port mapping works out of the box; mount your own `.config` to override settings.

## Tests

```bash
pytest tests -q
```
