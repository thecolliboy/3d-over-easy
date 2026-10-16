"""STL reader/writer covering both binary and ASCII variants.

Binary payloads are unpacked through struct layouts; ASCII documents are
walked line by line. Format detection keys off the header prefix, and
normals are recomputed from geometry when a file omits them.
"""
# ColliBoy

import struct
import io
from typing import Tuple, Optional

import numpy as np


# byte layout of binary STL records
_STL_HEADER_SIZE = 80
_STL_NUM_TRIANGLES = 4
_STL_TRIANGLE_SIZE = 50  # 12-byte normal + 36 bytes of corners + 2 attribute slots


class StlParseError(Exception):
    """Raised when an STL payload cannot be decoded."""
    pass


def detect_stl_format(data: bytes) -> str:
    """Classify raw bytes as binary or ASCII STL by inspecting the header prefix."""
    # strict ascii failure implies a binary-packed header
    try:
        text_candidate = data[:512].decode('ascii', errors='strict')
    except UnicodeDecodeError:
        return 'binary'

    # an ASCII document opens with a 'solid' keyword on its first line
    first_line = text_candidate.split('\n')[0].strip()
    if first_line.lower().startswith('solid'):
        # require facet/vertex keywords to confirm it is really STL text
        keyword_count = sum(1 for line in text_candidate.split('\n')[:20]
                          if 'facet normal' in line or 'vertex' in line)
        if keyword_count >= 3:
            return 'ascii'

    # control characters in the header indicate a binary payload
    has_non_printable = any(b < 9 or (b > 13 and b < 32) for b in data[:_STL_HEADER_SIZE])
    if has_non_printable:
        return 'binary'

    # unconfirmed text defaults to the more common binary layout
    return 'binary'


def parse_ascii_stl(data: bytes) -> Tuple[np.ndarray, np.ndarray]:
    """Decode an ASCII STL document into (vertices, normals) float32 arrays."""
    text = data.decode('ascii', errors='replace')
    lines = text.split('\n')

    vertices_list = []
    normals_list = []
    current_normal = None

    for line in lines:
        line = line.strip()

        if line.startswith('facet normal') or line.startswith('outer loop') or \
           line.startswith('endloop') or line.startswith('endfacet') or \
           line.startswith('solid') or not line:
            # facet headers carry the per-face normal for the corners that follow
            if line.startswith('facet normal'):
                parts = line.split()
                if len(parts) >= 5:
                    try:
                        current_normal = np.array([
                            float(parts[2]), float(parts[3]), float(parts[4])
                        ], dtype=np.float32)
                    except ValueError:
                        raise StlParseError(f"Invalid normal values on line: {line}")
                else:
                    current_normal = None
            continue

        if line.startswith('vertex'):
            parts = line.split()
            if len(parts) >= 4:
                try:
                    vertex = np.array([
                        float(parts[1]), float(parts[2]), float(parts[3])
                    ], dtype=np.float32)
                    vertices_list.append(vertex)

                    # corners inherit the facet normal, or zero when none was declared
                    if current_normal is not None:
                        normals_list.append(current_normal.copy())
                    else:
                        normals_list.append(np.zeros(3, dtype=np.float32))
                except ValueError:
                    raise StlParseError(f"Invalid vertex values on line: {line}")

    if len(vertices_list) == 0:
        raise StlParseError("No vertices found in ASCII STL file")

    vertices = np.array(vertices_list, dtype=np.float32)
    normals = np.array(normals_list, dtype=np.float32)

    return vertices, normals


def parse_binary_stl(data: bytes) -> Tuple[np.ndarray, np.ndarray]:
    """Unpack a binary STL payload into (vertices, normals) float32 arrays."""
    if len(data) < _STL_HEADER_SIZE + _STL_NUM_TRIANGLES:
        raise StlParseError("File too small to be a valid STL")

    offset = _STL_HEADER_SIZE

    # triangle count is stored as uint32 right after the 80-byte header
    num_triangles = struct.unpack_from('<I', data, offset)[0]
    offset += 4

    expected_size = _STL_HEADER_SIZE + 4 + (num_triangles * _STL_TRIANGLE_SIZE)
    if len(data) < expected_size:
        raise StlParseError(
            f"File size mismatch: expected {expected_size} bytes, got {len(data)}"
        )

    # pre-allocate output arrays so the unpack loop only writes slots
    num_vertices = num_triangles * 3
    vertices = np.empty((num_vertices, 3), dtype=np.float32)
    normals = np.empty((num_vertices, 3), dtype=np.float32)

    # each 50-byte record holds a normal, three corners, and an attribute count
    for i in range(num_triangles):
        tri_offset = offset + (i * _STL_TRIANGLE_SIZE)

        nx, ny, nz = struct.unpack_from('<fff', data, tri_offset)
        triangle_normal = np.array([nx, ny, nz], dtype=np.float32)

        v1x, v1y, v1z = struct.unpack_from('<fff', data, tri_offset + 12)
        v2x, v2y, v2z = struct.unpack_from('<fff', data, tri_offset + 24)
        v3x, v3y, v3z = struct.unpack_from('<fff', data, tri_offset + 36)

        base_idx = i * 3
        vertices[base_idx] = [v1x, v1y, v1z]
        vertices[base_idx + 1] = [v2x, v2y, v2z]
        vertices[base_idx + 2] = [v3x, v3y, v3z]

        # assign the face normal to all three corners of the record
        normals[base_idx] = triangle_normal
        normals[base_idx + 1] = triangle_normal
        normals[base_idx + 2] = triangle_normal

    return vertices, normals


def parse_stl(data: bytes) -> Tuple[np.ndarray, np.ndarray]:
    """Decode an STL payload into (vertices, normals), dispatching on the detected format."""
    fmt = detect_stl_format(data)

    if fmt == 'ascii':
        return parse_ascii_stl(data)
    else:
        return parse_binary_stl(data)


def compute_normals_from_vertices(vertices: np.ndarray,
                                   tri_indices: np.ndarray) -> np.ndarray:
    """Derive per-corner normals by crossing edge vectors of each triangle."""
    num_tris = tri_indices.shape[0]
    normals = np.empty((num_tris * 3, 3), dtype=np.float32)

    v0 = vertices[tri_indices[:, 0]]
    v1 = vertices[tri_indices[:, 1]]
    v2 = vertices[tri_indices[:, 2]]

    edge1 = v1 - v0
    edge2 = v2 - v0

    # the cross product of two edges is the face normal
    face_normals = np.cross(edge1, edge2)

    # each face normal is assigned to its three corners via stride-3 slices
    for i in range(3):
        normals[i::3] = face_normals

    return normals


def write_binary_stl(vertices: np.ndarray,
                     tri_indices: Optional[np.ndarray] = None,
                     normals: Optional[np.ndarray] = None) -> bytes:
    """Serialize mesh arrays into a binary STL payload."""
    vertices = np.asarray(vertices, dtype=np.float32)

    if tri_indices is not None:
        # STL records are unindexed, so the index set is expanded into flat corner runs
        num_tris = tri_indices.shape[0]
        flat_vertices = vertices[tri_indices.reshape(-1)]

        # missing normals are derived from the geometry itself
        if normals is None:
            corners = np.arange(num_tris * 3, dtype=np.uint32).reshape(-1, 3)
            normals = compute_normals_from_vertices(flat_vertices, corners)

        vertices = flat_vertices
    else:
        num_tris = vertices.shape[0] // 3
        remainder = vertices.shape[0] % 3
        if remainder != 0:
            raise StlParseError(
                f"Vertex count ({vertices.shape[0]}) must be divisible by 3 "
                f"(each triangle has 3 vertices)"
            )

        # missing normals are derived from the geometry itself
        if normals is None:
            tri_indices = np.arange(num_tris * 3, dtype=np.uint32).reshape(-1, 3)
            normals = compute_normals_from_vertices(vertices, tri_indices)

    header = b'Binary STL generated by Web 3D Builder\x00'
    # pad the fixed 80-byte header with nulls (ColliBoy)
    header = header[:_STL_HEADER_SIZE].ljust(_STL_HEADER_SIZE, b'\x00')

    buffer = io.BytesIO()
    buffer.write(header)
    buffer.write(struct.pack('<I', num_tris))

    for i in range(num_tris):
        base_idx = i * 3

        nx, ny, nz = normals[base_idx]
        buffer.write(struct.pack('<fff', float(nx), float(ny), float(nz)))

        # the three corners follow the normal inside each record
        for j in range(3):
            vx, vy, vz = vertices[base_idx + j]
            buffer.write(struct.pack('<fff', float(vx), float(vy), float(vz)))

        # attribute byte count is always zero in this writer
        buffer.write(struct.pack('<H', 0))

    return buffer.getvalue()


def write_ascii_stl(vertices: np.ndarray,
                    tri_indices: Optional[np.ndarray] = None,
                    normals: Optional[np.ndarray] = None) -> bytes:
    """Serialize mesh arrays into an ASCII STL document."""
    vertices = np.asarray(vertices, dtype=np.float32)

    if tri_indices is not None:
        # STL records are unindexed, so the index set is expanded into flat corner runs
        num_tris = tri_indices.shape[0]
        vertices = vertices[tri_indices.reshape(-1)]

        # missing normals are derived from the geometry itself
        if normals is None:
            corners = np.arange(num_tris * 3, dtype=np.uint32).reshape(-1, 3)
            normals = compute_normals_from_vertices(vertices, corners)
    else:
        num_tris = vertices.shape[0] // 3
        remainder = vertices.shape[0] % 3
        if remainder != 0:
            raise StlParseError(
                f"Vertex count ({vertices.shape[0]}) must be divisible by 3"
            )

        # missing normals are derived from the geometry itself
        if normals is None:
            tri_indices = np.arange(num_tris * 3, dtype=np.uint32).reshape(-1, 3)
            normals = compute_normals_from_vertices(vertices, tri_indices)

    lines = ['solid mesh']

    for i in range(num_tris):
        base_idx = i * 3
        nx, ny, nz = normals[base_idx]
        lines.append(f'facet normal {nx:.7f} {ny:.7f} {nz:.7f}')
        lines.append('  outer loop')

        for j in range(3):
            vx, vy, vz = vertices[base_idx + j]
            lines.append(f'    vertex {vx:.7f} {vy:.7f} {vz:.7f}')

        lines.append('  endloop')
        lines.append('endfacet')

    lines.append('endsolid mesh')
    return '\n'.join(lines).encode('ascii')


def write_stl(vertices: np.ndarray,
              tri_indices: Optional[np.ndarray] = None,
              normals: Optional[np.ndarray] = None,
              binary: bool = True) -> bytes:
    """Serialize a mesh to STL, defaulting to the smaller binary layout."""
    if binary:
        return write_binary_stl(vertices, tri_indices, normals)
    else:
        return write_ascii_stl(vertices, tri_indices, normals)
