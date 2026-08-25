"""GLB / GLTF geometry extractor for Khronos glTF 2.0 model files.

Covers both container variants of the spec: binary GLB and JSON GLTF.
Pulls out mesh positions, normals, vertex colors, and index buffers
from accessor/bufferView pairs. External buffer references and non-triangle
primitive modes are out of scope.
"""
# ColliBoy

import struct
import json
from typing import Tuple, Optional, Dict, List, Any
from dataclasses import dataclass, field


@dataclass
class GlTFMesh:
    """Geometry container for one glTF mesh; flat attribute arrays plus optional indices."""
    vertices: List[float] = field(default_factory=list)  # flat x,y,z triplets
    normals: Optional[List[float]] = None
    colors: Optional[List[float]] = None
    indices: Optional[List[int]] = None


@dataclass
class GlTFScene:
    """All meshes extracted from one glTF file."""
    meshes: List[GlTFMesh] = field(default_factory=list)


class GlTfParseError(Exception):
    """Raised when a GLB or GLTF payload fails detection or decoding."""
    pass


# glTF componentType enum values mapped to (struct char, element size)
_COMPONENT_TYPES = {
    5120: ('i1', 1),      # signed byte
    5121: ('B', 1),       # unsigned byte
    5122: ('h', 2),       # signed short
    5123: ('H', 2),       # unsigned short
    5126: ('f', 4),       # single-precision float
}

# glTF accessor type names mapped to component counts
_TYPE_COMPONENTS = {
    'SCALAR': 1,
    'VEC2': 2,
    'VEC3': 3,
    'VEC4': 4,
    'MAT2': 4,
    'MAT3': 9,
    'MAT4': 16,
}


def detect_gltf_format(data: bytes) -> str:
    """Sniff a byte prefix and classify it as 'glb', 'gltf', or None."""
    # GLB containers open with the ASCII magic bytes 'glTF'
    if len(data) >= 4 and data[:4] == b'glTF':
        return 'glb'

    try:
        text = data.decode('ascii', errors='strict')
        if text.strip().startswith('{'):
            parsed = json.loads(text)
            if isinstance(parsed, dict) and ('asset' in parsed) and ('meshes' in parsed or 'scenes' in parsed):
                return 'gltf'
    except (UnicodeDecodeError, json.JSONDecodeError):
        pass

    return None


def parse_glb(data: bytes) -> GlTFScene:
    """Decode a binary glTF container into a GlTFScene; raises GlTfParseError on malformed input."""
    if len(data) < 12:
        raise GlTfParseError("File too small to be a valid GLB")

    # validate the magic bytes and format version
    magic = data[:4]
    if magic != b'glTF':
        raise GlTfParseError(f"Invalid GLB magic: {magic}")

    version, length = struct.unpack_from('<II', data, 4)
    if version != 2:
        raise GlTfParseError(f"Unsupported glTF version: {version} (expected 2)")

    offset = 12

    json_chunk_data = None
    binary_chunk_data = None

    while offset < len(data):
        if offset + 8 > len(data):
            break

        chunk_length, chunk_type = struct.unpack_from('<II', data, offset)
        offset += 8

        chunk_end = offset + chunk_length

        if chunk_type == 0x4E4F534A:  # JSON payload chunk
            json_bytes = data[offset:chunk_end]
            try:
                json_chunk_data = json_bytes.decode('utf-8')
            except UnicodeDecodeError:
                raise GlTfParseError("JSON chunk is not valid UTF-8")

        elif chunk_type == 0x004E4942:  # binary data chunk
            binary_chunk_data = data[offset:chunk_end]

        offset = chunk_end

    if json_chunk_data is None:
        raise GlTfParseError("GLB file missing JSON chunk")

    return _parse_gltf_json(json.loads(json_chunk_data), binary_chunk_data)


def parse_gltf(data: bytes) -> GlTFScene:
    """Decode a JSON glTF document into a GlTFScene; raises GlTfParseError on malformed input."""
    try:
        json_data = json.loads(data.decode('utf-8', errors='replace'))
    except json.JSONDecodeError as e:
        raise GlTfParseError(f"Invalid JSON in GLTF file: {e}")

    if not isinstance(json_data, dict):
        raise GlTfParseError("GLTF root must be a JSON object")

    # external buffer references need a base path, so only self-contained files are decoded here
    return _parse_gltf_json(json_data, None)


def _parse_gltf_json(json_data: Dict[str, Any], binary_buffer: Optional[bytes]) -> GlTFScene:
    """Build a GlTFScene from parsed glTF JSON plus the optional embedded binary buffer."""
    if 'asset' not in json_data:
        raise GlTfParseError("Invalid glTF: missing 'asset' property")

    # pull geometry out of every mesh entry
    return GlTFScene(meshes=_extract_mesh_from_gltf(json_data, binary_buffer))


def _extract_mesh_from_gltf(json_data: Dict[str, Any], binary_buffer: Optional[bytes]) -> List[GlTFMesh]:
    """Turn glTF mesh entries into GlTFMesh objects, reading attributes from accessors."""
    meshes = []
    accessors = json_data.get('accessors', [])
    buffer_views = json_data.get('bufferViews', [])
    buffers = json_data.get('buffers', [])

    # map each bufferView to its byte slice in the embedded buffer
    view_buffers = {}
    for vi, view in enumerate(buffer_views):
        buf_idx = view.get('buffer', 0)
        if buf_idx < len(buffers) and binary_buffer is not None:
            buf_data = binary_buffer
            byte_offset = view.get('byteOffset', 0)
            byte_length = view['byteLength']
            view_buffers[vi] = buf_data[byte_offset:byte_offset + byte_length]

    for mesh_data in json_data.get('meshes', []):
        gltf_mesh = GlTFMesh()

        primitives = mesh_data.get('primitives', [])
        if not primitives:
            continue

        # only the first primitive is decoded; multi-primitive meshes are out of scope (ColliBoy)
        prim = primitives[0]
        mode = prim.get('mode', 4)  # glTF defaults an omitted mode to TRIANGLES

        if mode != 4:
            raise GlTfParseError(f"Unsupported primitive mode {mode}. Only TRIANGLES (4) supported.")

        attributes = prim.get('attributes', {})
        indices_accessor_idx = prim.get('indices')

        # POSITION is mandatory; skip the mesh when it is missing
        if 'POSITION' not in attributes:
            continue

        pos_acc_idx = attributes['POSITION']
        positions = _read_accessor(accessors, view_buffers, pos_acc_idx)

        if positions is None or len(positions) < 3:
            continue

        gltf_mesh.vertices = positions

        # NORMAL attribute, decoded when present
        if 'NORMAL' in attributes:
            norm_acc_idx = attributes['NORMAL']
            normals = _read_accessor(accessors, view_buffers, norm_acc_idx)
            if normals:
                gltf_mesh.normals = normals

        # vertex color from COLOR_0 or any CUSTOM_* attribute
        color_key = None
        for key in attributes:
            if 'COLOR' in key or key.startswith('CUSTOM'):
                color_key = key
                break

        if color_key:
            col_acc_idx = attributes[color_key]
            colors = _read_accessor(accessors, view_buffers, col_acc_idx)
            if colors:
                gltf_mesh.colors = colors

        # index accessor is optional; unindexed meshes list one vertex per corner
        if indices_accessor_idx is not None:
            indices = _read_accessor_as_uint(accessors, view_buffers, indices_accessor_idx)
            if indices:
                gltf_mesh.indices = indices

        meshes.append(gltf_mesh)

    return meshes


def _read_accessor(accessors: List[Dict], buffer_views: Dict[int, bytes],
                   accessor_idx: int) -> Optional[List[float]]:
    """Decode a glTF accessor into a flat float list; returns None when the data cannot be read."""
    if accessor_idx < 0 or accessor_idx >= len(accessors):
        return None

    accessor = accessors[accessor_idx]
    view_idx = accessor.get('bufferView')
    byte_offset = accessor.get('byteOffset', 0)
    component_type = accessor.get('componentType', 5126)  # glTF defaults componentType to FLOAT (5126)
    count = accessor.get('count', 0)
    accessor_type = accessor.get('type', 'VEC3')

    num_components = _TYPE_COMPONENTS.get(accessor_type, 3)

    if view_idx is not None and view_idx in buffer_views:
        buf_data = buffer_views[view_idx]
        start = byte_offset
        end = start + count * num_components * (_COMPONENT_TYPES.get(component_type, ('f', 4))[1])
        raw_data = buf_data[start:end]
    else:
        # no backing buffer view; fill with zeros so downstream shapes stay uniform
        return [0.0] * (count * num_components)

    struct_code = _COMPONENT_TYPES.get(component_type, ('f', 4))[0]
    fmt = f'<{count * num_components}{struct_code}'

    try:
        values = list(struct.unpack(fmt, raw_data))
    except struct.error:
        return None

    # byte-sized color components are rescaled into the 0-1 range
    if component_type in (5120, 5121) and num_components <= 4:
        values = [v / 255.0 for v in values]

    return values


def _read_accessor_as_uint(accessors: List[Dict], buffer_views: Dict[int, bytes],
                           accessor_idx: int) -> Optional[List[int]]:
    """Decode an index accessor into a flat list of unsigned integers."""
    if accessor_idx < 0 or accessor_idx >= len(accessors):
        return None

    accessor = accessors[accessor_idx]
    view_idx = accessor.get('bufferView')
    byte_offset = accessor.get('byteOffset', 0)
    component_type = accessor.get('componentType', 5123)  # glTF defaults componentType to UNSIGNED_SHORT (5123)
    count = accessor.get('count', 0)

    if view_idx is not None and view_idx in buffer_views:
        buf_data = buffer_views[view_idx]
        start = byte_offset
        end = start + count * (_COMPONENT_TYPES.get(component_type, ('H', 2))[1])
        raw_data = buf_data[start:end]
    else:
        return None

    struct_code = _COMPONENT_TYPES.get(component_type, ('H', 2))[0]
    fmt = f'<{count}{struct_code}'

    try:
        return list(struct.unpack(fmt, raw_data))
    except struct.error:
        return None


def gltf_to_mesh_arrays(gltf_mesh: GlTFMesh) -> Tuple[List[float], Optional[List[int]],
                                                        Optional[List[float]], Optional[List[float]]]:
    """Flatten a GlTFMesh into the (vertices, indices, normals, colors) tuple downstream stages expect."""
    if len(gltf_mesh.vertices) < 3:
        raise GlTfParseError("Mesh has no valid vertices")

    return (
        gltf_mesh.vertices,
        gltf_mesh.indices,
        gltf_mesh.normals,
        gltf_mesh.colors,
    )
