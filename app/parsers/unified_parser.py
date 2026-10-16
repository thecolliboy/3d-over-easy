"""Single entry point for importing 3D model files.

Resolves the format from the filename extension or, when that is missing or
ambiguous, by sniffing the payload itself, then dispatches to the matching
per-format parser. Supported: STL, OBJ, PLY, GLB/GLTF, 3MF.
"""
# ColliBoy

from app.parsers.stl_parser import parse_stl as _parse_stl_raw
from app.parsers.obj_parser import parse_obj as _parse_obj_raw, obj_to_mesh_arrays
from app.parsers.ply_parser import parse_ply as _parse_ply_raw, ply_to_mesh_arrays
from app.parsers.glb_gltf_parser import parse_glb, parse_gltf, gltf_to_mesh_arrays
from app.parsers._3mf_parser import parse_3mf, apply_item_transform


FORMAT_MAP = {
    'stl': 'stl',
    'obj': 'obj',
    'ply': 'ply',
    '3mf': '3mf',
    'glb': 'glb',
    'gltf': 'gltf',
}


def detect_format(filename, file_data):
    """Resolve the format of a payload from its extension or content.

    The extension is tried first; unknown extensions fall back to sniffing
    the leading bytes. Returns 'stl', 'obj', 'ply', 'glb', 'gltf', '3mf',
    or None when nothing matches.
    """
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    if ext in FORMAT_MAP:
        return FORMAT_MAP[ext]

    # unknown extension - sniff the leading bytes instead
    header = file_data[:512].decode('ascii', errors='ignore').lower()

    # ascii STL documents carry facet/vertex keywords near the top
    if 'facet normal' in header or ('vertex' in header and 'solid' in header):
        return 'stl'

    # position records open with a bare 'v ' token
    for line in header.split('\n')[:10]:
        stripped = line.strip()
        if stripped.startswith('v ') and len(stripped.split()) >= 4:
            return 'obj'

    # ply documents begin with the 'ply' magic word
    if header.lstrip().startswith('ply'):
        return 'ply'

    # glb containers carry the four-byte 'glTF' magic
    if file_data[:4] == b'glTF':
        return 'glb'

    # 3mf archives are zip containers - confirm via their model part
    if len(file_data) >= 4 and file_data[:4] == b'PK\x03\x04':
        try:
            import zipfile
            import io
            with zipfile.ZipFile(io.BytesIO(file_data)) as zf:
                for name in zf.namelist():
                    if 'model' in name.lower() and (name.endswith('.xml') or '.model' in name):
                        return '3mf'
        except Exception:
            pass

    return ext if ext else None


def parse_mesh(filename, file_data):
    """Parse a model file into flat mesh arrays, dispatching on the detected format.

    Returns a dict with keys vertices, indices, normals, colors, num_vertices,
    and num_faces. Raises ValueError when the format is unsupported or the
    payload cannot be parsed.
    """
    fmt = detect_format(filename, file_data)
    if not fmt:
        raise ValueError(f'Unsupported format: {filename}')

    try:
        if fmt == 'stl':
            return _parse_stl(file_data)
        elif fmt == 'obj':
            return _parse_obj(file_data)
        elif fmt == 'ply':
            return _parse_ply(file_data)
        elif fmt in ('glb', 'gltf'):
            return _parse_glb_gltf(fmt, file_data)
        elif fmt == '3mf':
            return _parse_3mf(file_data)
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f'Failed to parse {filename} ({fmt}): {str(e)}')

    raise ValueError(f'Format ".{fmt}" is not supported for parsing.')


def _parse_stl(data):
    """Run the STL parser and reshape its output into the common mesh dict."""
    vertices, normals = _parse_stl_raw(data)

    num_verts = vertices.shape[0]
    num_faces = vertices.shape[0] // 3

    flat_vertices = vertices.flatten().tolist()
    flat_normals = normals.flatten().tolist() if normals is not None else None

    return {
        'vertices': flat_vertices,
        'indices': None,
        'normals': flat_normals,
        'colors': None,
        'num_vertices': num_verts,
        'num_faces': num_faces,
    }


def _parse_obj(data):
    """Run the OBJ parser and convert its scene to flat mesh arrays."""
    obj_mesh = _parse_obj_raw(data)

    try:
        flat_vertices, indices, flat_normals = obj_to_mesh_arrays(obj_mesh)
    except Exception as e:
        raise ValueError(f'Failed to convert OBJ to mesh arrays: {e}')

    num_verts = len(flat_vertices) // 3
    num_faces = len(indices) // 3 if indices else 0

    return {
        'vertices': flat_vertices,
        'indices': indices,
        'normals': flat_normals,
        'colors': None,
        'num_vertices': num_verts,
        'num_faces': num_faces,
    }


def _parse_ply(data):
    """Run the PLY parser and convert its elements to flat mesh arrays."""
    ply_mesh = _parse_ply_raw(data)

    try:
        flat_vertices, indices, flat_normals, flat_colors = ply_to_mesh_arrays(ply_mesh)
    except Exception as e:
        raise ValueError(f'Failed to convert PLY to mesh arrays: {e}')

    num_verts = len(flat_vertices) // 3
    num_faces = len(indices) // 3 if indices else 0

    return {
        'vertices': flat_vertices,
        'indices': indices,
        'normals': flat_normals,
        'colors': flat_colors,
        'num_vertices': num_verts,
        'num_faces': num_faces,
    }


def _parse_glb_gltf(fmt, data):
    """Parse a GLB or JSON glTF file and merge every mesh in the scene."""
    try:
        if fmt == 'glb':
            scene = parse_glb(data)
        else:
            scene = parse_gltf(data)
    except Exception as e:
        raise ValueError(f'Failed to parse {fmt.upper()}: {e}')

    if not scene.meshes:
        raise ValueError(f'No meshes found in {fmt.upper()} file')

    # weld every mesh in the scene into one shared vertex/index pool
    vertices = []
    indices = []
    normals = None
    colors = None
    offset = 0
    num_faces = 0

    for gltf_mesh in scene.meshes:
        try:
            vert, idx, norm, col = gltf_to_mesh_arrays(gltf_mesh)
        except Exception as e:
            raise ValueError(f'Failed to convert GLTF mesh: {e}')

        vertices.extend(vert)
        if idx is not None:
            # rebase index offsets so each merged mesh points at its own vertices
            adjusted_idx = [i + offset for i in idx]
            indices.extend(adjusted_idx)
            num_faces += len(idx) // 3
            offset += len(vert) // 3

        if norm is not None and normals is None:
            normals = norm
        elif norm is not None and normals is not None:
            normals.extend(norm)

        if col is not None and colors is None:
            colors = col
        elif col is not None and colors is not None:
            colors.extend(col)

    num_verts = len(vertices) // 3

    return {
        'vertices': vertices,
        'indices': indices or None,
        'normals': normals,
        'colors': colors,
        'num_vertices': num_verts,
        'num_faces': num_faces,
    }


def _parse_3mf(data):
    """Parse a 3MF archive and merge all of its meshes into one pool."""
    try:
        scene = parse_3mf(data)
    except Exception as e:
        raise ValueError(f'Failed to parse 3MF: {e}')

    if not scene.meshes:
        raise ValueError('No meshes found in 3MF file')

    # merge every mesh into a single pool, mirroring the gltf path
    vertices = []
    indices = []
    colors = None
    offset = 0
    num_faces = 0

    for mesh_3mf in scene.meshes:
        try:
            vert, idx, col = _convert_3mf_mesh(mesh_3mf)
        except Exception as e:
            raise ValueError(f'Failed to convert 3MF mesh: {e}')

        vertices.extend(vert)
        if idx is not None:
            adjusted_idx = [i + offset for i in idx]
            indices.extend(adjusted_idx)
            num_faces += len(idx) // 3
            offset += len(vert) // 3

        if col is not None and colors is None:
            colors = col
        elif col is not None and colors is not None:
            colors.extend(col)

    num_verts = len(vertices) // 3

    return {
        'vertices': vertices,
        'indices': indices or None,
        'normals': None,
        'colors': colors,
        'num_vertices': num_verts,
        'num_faces': num_faces,
    }


def parse_3mf_meshes(data):
    """Parse a 3MF archive into one mesh dict per archive object.

    Unlike the merged pool in _parse_3mf, each object keeps its own vertex pool
    with its build-item transform baked in, so multi-model archives round-trip
    as separate models at their saved positions."""
    try:
        scene = parse_3mf(data)
    except Exception as e:
        raise ValueError(f'Failed to parse 3MF: {e}')

    if not scene.meshes:
        raise ValueError('No meshes found in 3MF file')

    meshes = []
    for mesh_3mf in scene.meshes:
        try:
            vert, idx, col = _convert_3mf_mesh(mesh_3mf)
        except Exception as e:
            raise ValueError(f'Failed to convert 3MF mesh: {e}')

        meshes.append({
            'vertices': vert,
            'indices': idx,
            'normals': None,
            'colors': col,
            'num_vertices': len(vert) // 3,
            'num_faces': len(idx) // 3 if idx else 0,
        })

    return meshes


def _convert_3mf_mesh(mesh_3mf):
    """Flatten one 3MF mesh record into (vertices, indices, colors) arrays."""
    if len(mesh_3mf.vertices) < 3:
        raise ValueError("3MF mesh has no valid vertices")

    # bake item transforms into vertices so each object keeps its archive position
    vertices = mesh_3mf.vertices
    if mesh_3mf.transform:
        vertices = apply_item_transform(vertices, mesh_3mf.transform)

    return (vertices, mesh_3mf.indices, mesh_3mf.colors)
