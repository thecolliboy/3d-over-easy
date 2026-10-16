"""OBJ (Wavefront) geometry extractor for text-based 3D model files.

Reads vertex positions, normals, texture coordinates, and faces using the
v/vt/vn reference syntax. Groups and objects are folded into named face
buckets; animation, subdivision, and other directives are out of scope.
"""
# ColliBoy

from typing import Tuple, Optional, Dict, List
from dataclasses import dataclass, field


@dataclass
class ObjMesh:
    """Parsed OBJ geometry: vertex/normal/UV arrays plus faces bucketed by group name."""
    vertices: List[Tuple[float, float, float]] = field(default_factory=list)
    normals: List[Tuple[float, float, float]] = field(default_factory=list)
    texture_coords: List[Tuple[float, float]] = field(default_factory=list)
    faces: List[List[int]] = field(default_factory=list)  # each entry holds (v, vt, vn) corner tuples
    groups: Dict[str, List[List[int]]] = field(default_factory=dict)
    current_group: str = 'default'


class ObjParseError(Exception):
    """Raised when an OBJ payload cannot be decoded."""
    pass


def parse_obj(data: bytes) -> ObjMesh:
    """Decode raw OBJ bytes into an ObjMesh; raises ObjParseError on malformed input."""
    text = data.decode('utf-8', errors='replace')
    return _parse_obj_text(text)


def _parse_obj_text(text: str) -> ObjMesh:
    """Walk the line-based OBJ document and fill an ObjMesh with its geometry."""
    mesh = ObjMesh()

    for line_num, raw_line in enumerate(text.split('\n'), 1):
        line = raw_line.strip()

        # blank lines and #-prefixed notes carry no geometry
        if not line or line.startswith('#'):
            continue

        parts = line.split()
        command = parts[0]

        try:
            if command == 'v':
                _parse_vertex(parts, mesh)
            elif command == 'vn':
                _parse_normal(parts, mesh)
            elif command == 'vt':
                _parse_texture_coord(parts, mesh)
            elif command == 'f':
                _parse_face(parts, mesh)
            elif command == 'g' or command == 'group':
                if len(parts) >= 2:
                    mesh.current_group = ' '.join(parts[1:])
                    if mesh.current_group not in mesh.groups:
                        mesh.groups[mesh.current_group] = []
            elif command == 'o':
                # object names double as group labels
                if len(parts) >= 2:
                    obj_name = ' '.join(parts[1:])
                    mesh.current_group = obj_name
                    if mesh.current_group not in mesh.groups:
                        mesh.groups[mesh.current_group] = []
            # remaining directives (s, r, ...) are dropped

        except (IndexError, ValueError) as e:
            raise ObjParseError(
                f"Line {line_num}: Failed to parse '{command}' directive: {e}"
            )

    if len(mesh.vertices) == 0:
        raise ObjParseError("No vertices found in OBJ file")

    return mesh


def _parse_vertex(parts: List[str], mesh: ObjMesh):
    """Append a 'v x y z' position to the vertex list."""
    if len(parts) < 4:
        raise ObjParseError(f"Invalid vertex: {parts}")

    x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
    mesh.vertices.append((x, y, z))


def _parse_normal(parts: List[str], mesh: ObjMesh):
    """Append a 'vn x y z' direction to the normal list."""
    if len(parts) < 4:
        raise ObjParseError(f"Invalid normal: {parts}")

    x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
    mesh.normals.append((x, y, z))


def _parse_texture_coord(parts: List[str], mesh: ObjMesh):
    """Append a 'vt u [v]' pair to the UV list; v defaults to 0 when omitted."""
    if len(parts) < 3:
        raise ObjParseError(f"Invalid texture coord: {parts}")

    u = float(parts[1])
    v = float(parts[2]) if len(parts) >= 4 else 0.0
    mesh.texture_coords.append((u, v))


def _parse_face(parts: List[str], mesh: ObjMesh):
    """Decode an 'f' line of corner references into (v, vt, vn) tuples; polygons fan-triangulate from the first corner."""
    if len(parts) < 4:
        raise ObjParseError(f"Invalid face (need at least 3 vertices): {parts}")

    # drop the leading 'f' token to isolate the corner references
    raw_refs = parts[1:]

    # each reference becomes a (v, vt, vn) tuple with -1 marking an absent component
    face_refs = []
    for ref in raw_refs:
        components = ref.split('/')

        if len(components) == 1:
            # bare vertex index
            v_idx = int(components[0]) - 1  # OBJ indices are 1-based; shift to 0-based
            face_refs.append((v_idx, -1, -1))
        elif len(components) == 2:
            # vertex paired with a texture coordinate
            v_idx = int(components[0]) - 1
            vt_idx = int(components[1]) - 1
            face_refs.append((v_idx, vt_idx, -1))
        elif len(components) == 3:
            # full vertex/texture/normal reference; empty slots stay -1
            v_idx = int(components[0]) - 1
            vt_idx = int(components[1]) - 1 if components[1] else -1
            vn_idx = int(components[2]) - 1 if components[2] else -1
            face_refs.append((v_idx, vt_idx, vn_idx))
        else:
            raise ObjParseError(f"Invalid face reference: {ref}")

    # triangles pass through; larger polygons fan out from the first corner
    if len(face_refs) == 3:
        faces_to_add = [face_refs]
    else:
        faces_to_add = []
        for i in range(1, len(face_refs) - 1):
            faces_to_add.append([face_refs[0], face_refs[i], face_refs[i + 1]])

    # file the resulting triangles under the active group name
    if mesh.current_group not in mesh.groups:
        mesh.groups[mesh.current_group] = []

    for face in faces_to_add:
        mesh.groups[mesh.current_group].append(face)
        mesh.faces.append(face)


def obj_to_mesh_arrays(obj_mesh: ObjMesh) -> Tuple[List[float], List[int], Optional[List[float]]]:
    """Flatten an ObjMesh into the (vertices, indices, normals) tuple downstream stages expect; corners sharing a (position, normal) pair reuse one output vertex so shared edges stay welded for manifold CSG."""
    vertices = obj_mesh.vertices
    normals = obj_mesh.normals
    faces = obj_mesh.faces

    if len(faces) == 0:
        raise ObjParseError("No faces found in OBJ file")

    flat_vertices = []
    indices = []
    flat_normals = None
    vertex_map = {}  # (v_idx, vn_idx) -> slot in the output arrays

    for face in faces:
        for ref in face:
            v_idx, vt_idx, vn_idx = ref

            if v_idx < 0 or v_idx >= len(vertices):
                raise ObjParseError(
                    f"Face references out-of-bounds vertex index {v_idx} "
                    f"(has {len(vertices)} vertices)"
                )

            has_normal = vn_idx >= 0 and normals and vn_idx < len(normals)
            key = (v_idx, vn_idx if has_normal else -1)

            existing_idx = vertex_map.get(key)
            if existing_idx is not None:
                indices.append(existing_idx)
                continue

            new_idx = len(flat_vertices) // 3
            flat_vertices.extend(vertices[v_idx])

            if has_normal:
                if flat_normals is None:
                    # first normal seen; pad earlier zero-normal slots so both arrays stay aligned
                    flat_normals = [0.0] * (new_idx * 3)
                flat_normals.extend(normals[vn_idx])
            elif flat_normals is not None:
                flat_normals.extend([0.0, 0.0, 0.0])

            vertex_map[key] = new_idx
            indices.append(new_idx)

    return flat_vertices, indices, flat_normals


def write_obj(
    vertices: List[float],
    indices: Optional[List[int]] = None,
    normals: Optional[List[float]] = None,
    name: str = 'model',
    uv_coords: Optional[List] = None
) -> bytes:
    """Serialize mesh arrays back to OBJ text; indexed input deduplicates vertices by position before emitting faces."""
    lines = []
    lines.append(f'# Exported from Web 3D Builder')
    lines.append(f'# Object: {name}')

    if indices is not None and len(indices) > 0:
        # indexed path: unique positions first, then face references
        unique_verts = []
        vert_map = {}

        for i in range(0, len(vertices), 3):
            key = (vertices[i], vertices[i + 1], vertices[i + 2])
            if key not in vert_map:
                vert_map[key] = len(unique_verts)
                unique_verts.append(key)

        # position lines for the deduplicated vertex set
        for vx, vy, vz in unique_verts:
            lines.append(f'v {vx:.6f} {vy:.6f} {vz:.6f}')

        # UV block when texture coordinates are present
        if uv_coords and len(uv_coords) > 0:
            for u, v in uv_coords:
                lines.append(f'vt {u:.6f} {v:.6f}')

        # normal block with its own deduplication pass
        if normals and len(normals) > 0:
            unique_normals = []
            norm_map = {}
            for i in range(0, len(normals), 3):
                key = (normals[i], normals[i + 1], normals[i + 2])
                if key not in norm_map:
                    norm_map[key] = len(unique_normals)
                    unique_normals.append(key)

            for nx, ny, nz in unique_normals:
                lines.append(f'vn {nx:.6f} {ny:.6f} {nz:.6f}')

        # face lines with 1-based indices
        lines.append('')
        face_count = len(indices) // 3
        for i in range(face_count):
            a = vert_map[(vertices[indices[i * 3] * 3],
                          vertices[indices[i * 3] * 3 + 1],
                          vertices[indices[i * 3] * 3 + 2])] + 1

            b = vert_map[(vertices[indices[i * 3 + 1] * 3],
                          vertices[indices[i * 3 + 1] * 3 + 1],
                          vertices[indices[i * 3 + 1] * 3 + 2])] + 1

            c = vert_map[(vertices[indices[i * 3 + 2] * 3],
                          vertices[indices[i * 3 + 2] * 3 + 1],
                          vertices[indices[i * 3 + 2] * 3 + 2])] + 1

            # UV slots mirror the vertex indices when UVs exist
            a_uv = a if uv_coords else None
            b_uv = b if uv_coords else None
            c_uv = c if uv_coords else None

            if normals and len(normals) > 0:
                na = norm_map[(normals[indices[i * 3] * 3],
                               normals[indices[i * 3] * 3 + 1],
                               normals[indices[i * 3] * 3 + 2])] + 1 if indices[i * 3] < len(normals) // 3 else a
                nb = norm_map[(normals[indices[i * 3 + 1] * 3],
                               normals[indices[i * 3 + 1] * 3 + 1],
                               normals[indices[i * 3 + 1] * 3 + 2])] + 1 if indices[i * 3 + 1] < len(normals) // 3 else b
                nc = norm_map[(normals[indices[i * 3 + 2] * 3],
                               normals[indices[i * 3 + 2] * 3 + 1],
                               normals[indices[i * 3 + 2] * 3 + 2])] + 1 if indices[i * 3 + 2] < len(normals) // 3 else c

                if uv_coords:
                    lines.append(f'f {a}/{a_uv}/{na} {b}/{b_uv}/{nb} {c}/{c_uv}/{nc}')
                else:
                    lines.append(f'f {a}/{na} {b}/{nb} {c}/{nc}')
            elif uv_coords:
                lines.append(f'f {a}/{a_uv} {b}/{b_uv} {c}/{c_uv}')
            else:
                lines.append(f'f {a} {b} {c}')

    else:
        # unindexed path: every three consecutive vertices form one triangle
        vert_count = len(vertices) // 3

        for i in range(vert_count):
            x, y, z = vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]
            lines.append(f'v {x:.6f} {y:.6f} {z:.6f}')

        # UV block when texture coordinates are present
        if uv_coords and len(uv_coords) > 0:
            for u, v in uv_coords[:vert_count]:
                lines.append(f'vt {u:.6f} {v:.6f}')

        if normals and len(normals) > 0:
            for i in range(vert_count):
                x, y, z = normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]
                lines.append(f'vn {x:.6f} {y:.6f} {z:.6f}')

        # face lines with 1-based indices
        lines.append('')
        for i in range(vert_count):
            a = i + 1
            b = i + 2 if i + 2 <= vert_count else 1
            c = i + 1 if i + 1 > vert_count else i + 2

            if uv_coords:
                lines.append(f'f {a}/{a} {b}/{b} {c}/{c}')
            else:
                lines.append(f'f {i + 1}')

    return '\n'.join(lines).encode('utf-8')
