<p align="center">
  <img src="static/img/banner.svg" alt="web-3d-builder logo" width="420">
</p>

A browser-based 3D mesh editor: Flask backend, Three.js frontend.

## Features

- Import STL, OBJ, PLY, GLB/GLTF, 3MF, FBX
- Export STL, OBJ, PLY
- CSG booleans (union, subtract, intersect) via manifold3d
- Geometry operations: repair, hollow, cut, scale, rotate, translate, simplify, smooth, fillet, chamfer
- Primitive solids (box, cylinder, sphere... and egg!)
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

Serves the editor at http://localhost:8181 by default. Host, port, and worker count come from `.config`, then `HOST`/`PORT` env vars, then built-in defaults.

## Tests

I wanted to include these in case anyone decides they wanted to make any major overhauls to their copy of the project.

```bash
pytest tests -q
```
