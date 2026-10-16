"""PLY (Polygon File Format) reader for ASCII and binary scan data.

Covers vertex positions, optional normals and colors, plus polygon faces.
Binary payloads are decoded through struct layouts derived from the header;
element types beyond vertex/face are not interpreted.
"""
# ColliBoy

import struct
import io
from typing import Tuple, Optional, List
from dataclasses import dataclass, field


@dataclass
class PlyVertex:
    """One mesh corner with position plus optional normal and color channels."""
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    nx: Optional[float] = None
    ny: Optional[float] = None
    nz: Optional[float] = None
    red: Optional[float] = None
    green: Optional[float] = None
    blue: Optional[float] = None


@dataclass
class PlyMesh:
    """Parsed PLY geometry: vertex list, face index lists, and element counts."""
    vertices: List[PlyVertex] = field(default_factory=list)
    faces: List[List[int]] = field(default_factory=list)  # each entry is a run of 0-based corner indices
    num_vertices: int = 0
    num_faces: int = 0
    format_type: str = 'ascii'  # ascii / binary_little_endian / binary_big_endian


class PlyParseError(Exception):
    """Raised when a PLY payload cannot be decoded."""
    pass


# struct codes and byte sizes for the property types declared in PLY headers
_TYPE_MAP = {
    'char': ('i1', 1),
    'uchar': ('B', 1),
    'short': ('h', 2),
    'ushort': ('H', 2),
    'int': ('i', 4),
    'uint': ('I', 4),
    'float': ('f', 4),
    'double': ('d', 8),
}


def detect_ply_format(data: bytes) -> str:
    """Classify raw bytes as ascii or binary PLY by inspecting the header prefix."""
    try:
        text = data[:512].decode('ascii', errors='strict')
    except UnicodeDecodeError:
        return 'binary'

    if text.strip().startswith('ply'):
        header_lines = text.split('\n')
        for line in header_lines[:5]:
            stripped = line.strip()
            if stripped == 'format binary_little_endian 1.0':
                return 'binary_little_endian'
            elif stripped == 'format binary_big_endian 1.0':
                return 'binary_big_endian'
            elif stripped.startswith('format'):
                if 'ascii' in stripped:
                    return 'ascii'

    # non-printable bytes in the leading block indicate a binary payload
    has_non_printable = any(b < 9 or (b > 13 and b < 32) for b in data[:80])
    if has_non_printable:
        return 'binary_little_endian'

    return 'ascii'


def parse_ply(data: bytes) -> PlyMesh:
    """Decode raw PLY bytes into a PlyMesh, dispatching on the detected format."""
    fmt = detect_ply_format(data)

    if fmt == 'ascii':
        return _parse_ascii_ply(data.decode('utf-8', errors='replace'))
    elif fmt == 'binary_little_endian':
        return _parse_binary_ply(data, '<')
    else:
        return _parse_binary_ply(data, '>')


def _read_header(text: str):
    """Walk the header lines and return (elements, end_offset) for the body that follows."""
    elements = {}
    current_element = None
    lines = text.split('\n')
    header_lines = []

    for line in lines:
        stripped = line.strip()
        header_lines.append(line)

        if stripped == 'end_header' or stripped == 'endsolid':
            # byte offset where element data begins once the header closes
            header_text = '\n'.join(header_lines)
            try:
                end_offset = text.index('end_header') + len('end_header')
            except ValueError:
                end_offset = len(header_text)

            return elements, end_offset

        if stripped.startswith('element '):
            parts = stripped.split()
            if len(parts) >= 3:
                elem_name = parts[1]
                elem_count = int(parts[2])
                elements[elem_name] = {'count': elem_count, 'properties': []}
                current_element = elem_name

        elif stripped.startswith('property ') and current_element:
            parts = stripped.split()
            if len(parts) >= 3:
                prop_type = parts[1]
                prop_name = parts[2]
                struct_code, byte_size = _TYPE_MAP.get(prop_type, ('f', 4))
                elements[current_element]['properties'].append({
                    'name': prop_name,
                    'type': prop_type,
                    'struct_code': struct_code,
                    'byte_size': byte_size,
                })

    return elements, 0


def _parse_ascii_ply(text: str) -> PlyMesh:
    """Decode an ASCII PLY document line by line into a PlyMesh."""
    elements, end_offset = _read_header(text[:text.index('end_header') + len('end_header')])

    mesh = PlyMesh()
    mesh.format_type = 'ascii'

    vertex_elem = elements.get('vertex', {})
    face_elem = elements.get('face', {})

    has_normal = any(p['name'] in ('nx', 'ny', 'nz') for p in vertex_elem.get('properties', []))
    has_color = any(p['name'] in ('red', 'green', 'blue') for p in vertex_elem.get('properties', []))

    # color channels may be packed as uchar or float depending on the exporter
    color_props = [p for p in vertex_elem.get('properties', []) if p['name'] in ('red', 'green', 'blue')]
    color_is_uchar = any(p['type'] == 'uchar' for p in color_props)

    lines = text[end_offset:].strip().split('\n')
    line_idx = 0

    # vertex block: one row per element, values in header-declared order
    num_vertices = vertex_elem.get('count', 0)
    for _ in range(num_vertices):
        if line_idx >= len(lines):
            break
        parts = lines[line_idx].strip().split()
        line_idx += 1

        if not parts:
            continue

        vertex = PlyVertex(
            x=float(parts[0]),
            y=float(parts[1]),
            z=float(parts[2]),
        )

        offset = 3
        if has_normal and len(parts) >= 6:
            vertex.nx = float(parts[offset])
            vertex.ny = float(parts[offset + 1])
            vertex.nz = float(parts[offset + 2])
            offset += 3

        if has_color and len(parts) >= offset + 3:
            if color_is_uchar:
                vertex.red = float(parts[offset]) / 255.0
                vertex.green = float(parts[offset + 1]) / 255.0
                vertex.blue = float(parts[offset + 2]) / 255.0
            else:
                vertex.red = float(parts[offset])
                vertex.green = float(parts[offset + 1])
                vertex.blue = float(parts[offset + 2])

        mesh.vertices.append(vertex)

    # face block: leading corner count followed by that many indices
    num_faces = face_elem.get('count', 0)
    for _ in range(num_faces):
        if line_idx >= len(lines):
            break
        parts = lines[line_idx].strip().split()
        line_idx += 1

        if not parts:
            continue

        try:
            num_verts_in_face = int(parts[0])
            face_indices = [int(v) for v in parts[1:num_verts_in_face + 1]]
            mesh.faces.append(face_indices)
        except (ValueError, IndexError):
            continue

    mesh.num_vertices = len(mesh.vertices)
    mesh.num_faces = len(mesh.faces)

    return mesh


def _parse_binary_ply(data: bytes, endian: str) -> PlyMesh:
    """Decode a binary PLY payload using struct layouts built from the header."""
    # locate the end_header marker to find where element data starts
    try:
        text_start = data[:8192].decode('ascii', errors='replace')
    except Exception:
        raise PlyParseError("Invalid PLY file: cannot read header")

    end_marker = 'end_header'
    if end_marker not in text_start:
        # retry with explicit line-ending variants when the plain search misses
        for marker in ['end_header\r\n', 'end_header\n']:
            idx = data.find(marker.encode())
            if idx >= 0:
                end_marker_pos = idx
                break
        else:
            raise PlyParseError("Invalid PLY file: 'end_header' not found")
    else:
        end_marker_pos = text_start.index(end_marker)

    header_text = data[:end_marker_pos].decode('ascii', errors='replace')
    elements, _ = _read_header(header_text)

    mesh = PlyMesh()
    mesh.format_type = 'binary_little_endian' if endian == '<' else 'binary_big_endian'

    vertex_elem = elements.get('vertex', {})
    face_elem = elements.get('face', {})

    # assemble the per-vertex struct format from the declared properties
    vertex_props = vertex_elem.get('properties', [])
    vertex_struct_fmt = endian + ''.join(p['struct_code'] for p in vertex_props)

    has_normal = any(p['name'] in ('nx', 'ny', 'nz') for p in vertex_props)
    color_present = [p for p in vertex_props if p['name'] in ('red', 'green', 'blue')]
    color_is_uchar = any(p['type'] == 'uchar' for p in color_present)

    # vertex block: fixed-size records unpacked one after another
    num_vertices = vertex_elem.get('count', 0)
    vertex_size = struct.calcsize(vertex_struct_fmt) if vertex_props else 12  # position-only fallback record size

    offset = end_marker_pos + len(end_marker)

    for _ in range(num_vertices):
        try:
            raw = data[offset:offset + vertex_size]
            if len(raw) < struct.calcsize(vertex_struct_fmt):
                break
            values = struct.unpack(vertex_struct_fmt, raw)
        except struct.error:
            break

        offset += vertex_size

        vertex = PlyVertex(
            x=float(values[0]),
            y=float(values[1]),
            z=float(values[2]),
        )

        prop_idx = 3
        if has_normal and len(vertex_props) >= 6:
            vertex.nx = float(values[prop_idx])
            vertex.ny = float(values[prop_idx + 1])
            vertex.nz = float(values[prop_idx + 2])
            prop_idx += 3

        if color_present and len(vertex_props) >= prop_idx + 3:
            if color_is_uchar:
                vertex.red = float(values[prop_idx]) / 255.0
                vertex.green = float(values[prop_idx + 1]) / 255.0
                vertex.blue = float(values[prop_idx + 2]) / 255.0
            else:
                vertex.red = float(values[prop_idx])
                vertex.green = float(values[prop_idx + 1])
                vertex.blue = float(values[prop_idx + 2])

        mesh.vertices.append(vertex)

    # face block: count field followed by the corner index values
    num_faces = face_elem.get('count', 0)

    for _ in range(num_faces):
        if offset >= len(data):
            break

        try:
            # leading field holds the corner count for this face
            count_size = 4  # uint32 slot
            raw_count = data[offset:offset + count_size]
            if len(raw_count) < count_size:
                break
            num_verts_in_face = struct.unpack(endian + 'I', raw_count)[0]
            offset += count_size

            # pull each corner index from its own uint32 slot
            face_indices = []
            for j in range(num_verts_in_face):
                idx_raw = data[offset:offset + 4]
                if len(idx_raw) < 4:
                    break
                idx_val = struct.unpack(endian + 'I', idx_raw)[0]
                face_indices.append(idx_val)
                offset += 4

            mesh.faces.append(face_indices)
        except (struct.error, ValueError):
            break

    mesh.num_vertices = len(mesh.vertices)
    mesh.num_faces = len(mesh.faces)

    return mesh


def ply_to_mesh_arrays(ply_mesh: PlyMesh) -> Tuple[List[float], Optional[List[int]],
                                                     Optional[List[float]], Optional[List[float]]]:
    """Flatten a PlyMesh into (vertices, indices, normals, colors) arrays for downstream stages."""
    if len(ply_mesh.vertices) == 0:
        raise PlyParseError("No vertices found in PLY file")

    # gather positions plus any attribute channels that are present
    flat_vertices = []
    flat_normals = None
    flat_colors = None

    for v in ply_mesh.vertices:
        flat_vertices.extend([v.x, v.y, v.z])

        if v.nx is not None:
            if flat_normals is None:
                flat_normals = []
            flat_normals.extend([v.nx, v.ny or 0.0, v.nz or 0.0])

        if v.red is not None:
            if flat_colors is None:
                flat_colors = []
            flat_colors.extend([v.red, v.green or 0.0, v.blue or 0.0])

    # fan-triangulate polygons so every face becomes triangle index runs
    indices = []
    for face in ply_mesh.faces:
        if len(face) < 3:
            continue
        if len(face) == 3:
            indices.extend(face)
        else:
            # triangles pass through; larger faces fan out from the first corner
            for i in range(1, len(face) - 1):
                indices.extend([face[0], face[i], face[i + 1]])

    return flat_vertices, indices or None, flat_normals, flat_colors


def write_ply(vertices: List[Tuple[float, float, float]],
              normals: Optional[List[Tuple[float, float, float]]] = None,
              colors: Optional[List[Tuple[float, float, float]]] = None,
              faces: Optional[List[List[int]]] = None,
              binary: bool = True) -> bytes:
    """Serialize mesh arrays back to PLY bytes in ascii or binary_little_endian form."""
    num_verts = len(vertices)

    if binary:
        return _write_binary_ply(vertices, normals, colors, faces, num_verts)
    else:
        return _write_ascii_ply(vertices, normals, colors, faces, num_verts)


def _write_ascii_ply(vertices, normals, colors, faces, num_verts):
    """Emit an ASCII PLY document with header, vertex rows, and face rows."""
    lines = ['ply', 'format ascii 1.0', f'element vertex {num_verts}']

    # position properties are always declared first
    lines.append('property float x')
    lines.append('property float y')
    lines.append('property float z')

    if normals:
        lines.append('property float nx')
        lines.append('property float ny')
        lines.append('property float nz')

    if colors:
        # color channels stored as uchar (0-255)
        lines.append('property uchar red')
        lines.append('property uchar green')
        lines.append('property uchar blue')

    if faces is not None and len(faces) > 0:
        lines.append(f'element face {len(faces)}')
        lines.append('property list uchar int vertex_indices')

    lines.append('end_header')

    for i, v in enumerate(vertices):
        line = f'{v[0]:.6f} {v[1]:.6f} {v[2]:.6f}'
        if normals and i < len(normals):
            line += f' {normals[i][0]:.6f} {normals[i][1]:.6f} {normals[i][2]:.6f}'
        if colors and i < len(colors):
            r = int(min(255, max(0, colors[i][0] * 255)))
            g = int(min(255, max(0, colors[i][1] * 255)))
            b = int(min(255, max(0, colors[i][2] * 255)))
            line += f' {r} {g} {b}'
        lines.append(line)

    if faces:
        for face in faces:
            indices_str = ' '.join(str(idx) for idx in face)
            lines.append(f'{len(face)} {indices_str}')

    return '\n'.join(lines).encode('utf-8')


def _write_binary_ply(vertices, normals, colors, faces, num_verts):
    """Emit a binary little-endian PLY document with packed vertex and face records."""
    header_lines = ['ply', 'format binary_little_endian 1.0', f'element vertex {num_verts}']

    header_lines.append('property float x')
    header_lines.append('property float y')
    header_lines.append('property float z')

    has_normals = normals is not None and len(normals) == num_verts
    has_colors = colors is not None and len(colors) == num_verts

    if has_normals:
        header_lines.append('property float nx')
        header_lines.append('property float ny')
        header_lines.append('property float nz')

    if has_colors:
        header_lines.append('property uchar red')
        header_lines.append('property uchar green')
        header_lines.append('property uchar blue')

    if faces is not None and len(faces) > 0:
        header_lines.append(f'element face {len(faces)}')
        header_lines.append('property list uchar int vertex_indices')

    header_lines.append('end_header')

    header = '\n'.join(header_lines).encode('ascii')
    padding = (4 - (len(header) % 4)) % 4
    # zero-pad the header to a 4-byte boundary (ColliBoy)
    header += b'\x00' * padding

    buffer = io.BytesIO()
    buffer.write(header)

    # vertex records packed in header-declared order
    for i, v in enumerate(vertices):
        buffer.write(struct.pack('<fff', v[0], v[1], v[2]))
        if has_normals:
            n = normals[i]
            buffer.write(struct.pack('<fff', n[0], n[1], n[2]))
        if has_colors:
            c = colors[i]
            r = int(min(255, max(0, c[0] * 255)))
            g = int(min(255, max(0, c[1] * 255)))
            b = int(min(255, max(0, c[2] * 255)))
            buffer.write(struct.pack('<BBB', r, g, b))

    # face records: count byte followed by signed index values
    if faces:
        for face in faces:
            buffer.write(struct.pack('B', len(face)))
            for idx in face:
                buffer.write(struct.pack('<i', idx))

    return buffer.getvalue()


def get_ply_stats(data: bytes) -> dict:
    """Cheap element counts for import previews, read straight from the header."""
    fmt = detect_ply_format(data)
    size_bytes = len(data)

    try:
        if fmt == 'ascii':
            text = data.decode('utf-8', errors='replace')
        else:
            text = data[:4096].decode('ascii', errors='replace')

        elements, end_offset = _read_header(text[:text.index('end_header') + len('end_header')])

        vertex_elem = elements.get('vertex', {})
        face_elem = elements.get('face', {})

        num_vertices = vertex_elem.get('count', 0)
        num_faces = face_elem.get('count', 0)

        has_colors = any(p['name'] in ('red', 'green', 'blue') for p in vertex_elem.get('properties', []))

        return {
            'format': f'PLY ({fmt})',
            'num_vertices': num_vertices,
            'num_faces': num_faces,
            'has_colors': has_colors,
            'size_bytes': size_bytes,
        }
    except Exception:
        return {
            'format': 'PLY',
            'num_vertices': 0,
            'num_faces': 0,
            'has_colors': False,
            'size_bytes': size_bytes,
        }
