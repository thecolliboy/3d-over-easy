"""Manifold3D-backed mesh engine: CSG booleans, solidify, hollowing, plane cuts, transforms, simplification, smoothing, and primitive generation.

Every public function takes and returns plain numpy arrays - vertices (N, 3) float32 positions plus tri_indices (T, 3) uint32 vertex indices - so callers never touch the binding types directly.
"""
# ColliBoy

import math

from typing import Tuple, Optional, List

import numpy as np
import manifold3d as m


class ManifoldError(Exception):
    """Base exception for failed or invalid mesh operations."""
    pass


def _to_mesh(vertices: np.ndarray, tri_indices: np.ndarray) -> m.Mesh:
    """Build a m.Mesh from numpy vertex/index arrays."""
    # copy=True so the binding owns the buffers - it rejects borrowed views
    vertices = np.array(vertices, dtype=np.float32, order='C', copy=True)
    tri_indices = np.array(tri_indices, dtype=np.uint32, order='C', copy=True)
    return m.Mesh(vertices, tri_indices)


def _to_manifold(vertices: np.ndarray, tri_indices: np.ndarray) -> m.Manifold:
    """Wrap numpy vertex/index arrays in a watertight manifold3d Manifold.

    Imported models are assumed watertight; if the direct conversion fails,
    vertices are snapped to a 0.001 grid (closing float-noise seams) and an
    edge-merging repair pass is tried before giving up with ManifoldError.
    """
    # Imported STLs carry float noise (~1e-6) between coincident vertices; a
    # 0.001 grid snap welds those seams shut with no visible loss at typical scales.
    rounded_vertices = np.round(vertices.astype(np.float64), decimals=3).astype(np.float32)

    mesh = _to_mesh(rounded_vertices, tri_indices)
    manifold = m.Manifold(mesh)

    if manifold.num_tri() > 0 and manifold.status() == m.Error.NoError:
        return manifold

    # Second chance: merge() welds vertices across open edges using the mesh's own tolerance.
    try:
        merged = m.Mesh(rounded_vertices, tri_indices)
        merged.merge()
        manifold = m.Manifold(merged)
        if manifold.num_tri() > 0 and manifold.status() == m.Error.NoError:
            return manifold
    except Exception:
        pass

    raise ManifoldError(
        "Mesh is not watertight (not a closed solid volume). "
        "Imported models must be manifold (watertight) for boolean operations. "
        "Repair the mesh in a 3D editor or export as a solid format."
    )


def _validate_mesh(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    context: str = "mesh"
) -> None:
    """Reject empty, NaN/Inf, out-of-range, or degenerate meshes before they reach Manifold3D.

    `context` names the offending mesh in the error messages.
    """
    if len(vertices) == 0:
        raise ManifoldError(f"{context} has no vertices")

    if np.any(np.isnan(vertices)) or np.any(np.isinf(vertices)):
        raise ManifoldError(
            f"{context} has invalid vertex values (NaN or Inf). "
            f"Please repair the mesh before performing boolean operations."
        )

    if len(tri_indices) == 0:
        raise ManifoldError(f"{context} has no triangles")

    max_idx = tri_indices.max()
    if max_idx >= len(vertices):
        raise ManifoldError(
            f"{context} has invalid triangle indices: "
            f"max index {int(max_idx)} exceeds vertex count {len(vertices)}"
        )

    bbox_min = vertices.min(axis=0)
    bbox_max = vertices.max(axis=0)
    dims = bbox_max - bbox_min
    if np.all(dims < 1e-12):
        raise ManifoldError(
            f"{context} is degenerate: all vertices occupy the same point "
            f"(bounding box size: {dims.tolist()})"
        )

    # Zero-area faces make booleans come back empty even with valid indices, so reject them up front.
    v0 = vertices[tri_indices[:, 0]]
    v1 = vertices[tri_indices[:, 1]]
    v2 = vertices[tri_indices[:, 2]]
    edge1 = v1 - v0
    edge2 = v2 - v0
    cross = np.cross(edge1, edge2)
    areas = 0.5 * np.linalg.norm(cross, axis=1)
    if np.all(areas < 1e-18):
        raise ManifoldError(
            f"{context} is degenerate: all triangles have zero area"
        )


def _extract_mesh(manifold: m.Manifold, operation: str = "boolean") -> Tuple[np.ndarray, np.ndarray]:
    """Pull (vertices, tri_indices) numpy arrays back out of a Manifold result; raises if the operation failed or came back empty."""
    if not hasattr(manifold, 'to_mesh'):
        raise ManifoldError(
            f"{operation} did not return a valid manifold result. "
            f"This can happen with non-manifold geometry, degenerate meshes, "
            f"or self-intersecting surfaces."
        )

    mesh = manifold.to_mesh()
    vertices = np.asarray(mesh.vert_properties, dtype=np.float32)
    tri_indices = np.asarray(mesh.tri_verts, dtype=np.uint32)

    if vertices.shape[0] == 0 or tri_indices.shape[0] == 0:
        raise ManifoldError(
            f"{operation} produced an empty mesh. "
            f"This usually means the input meshes do not overlap in volume, "
            f"or contain degenerate geometry (flat surfaces, zero-area faces). "
            f"Ensure objects occupy overlapping 3D space with solid volumes."
        )

    return vertices, tri_indices


def union(
    meshes: List[Tuple[np.ndarray, np.ndarray]]
) -> Tuple[np.ndarray, np.ndarray]:
    """Boolean union of two or more meshes into one solid."""
    if len(meshes) < 2:
        raise ManifoldError("Union requires at least 2 meshes")

    for i, (v, t) in enumerate(meshes):
        _validate_mesh(v, t, f"mesh {i + 1} in union")

    manifolds = [_to_manifold(v, t) for v, t in meshes]
    result = m.Manifold.batch_boolean(manifolds, m.OpType.Add)
    return _extract_mesh(result, "union")


def subtract(
    base: Tuple[np.ndarray, np.ndarray],
    tool: Tuple[np.ndarray, np.ndarray]
) -> Tuple[np.ndarray, np.ndarray]:
    """Boolean subtraction: base minus tool."""
    _validate_mesh(*base, "base mesh for subtract")
    _validate_mesh(*tool, "tool mesh for subtract")

    base_manifold = _to_manifold(*base)
    tool_manifold = _to_manifold(*tool)
    result = m.Manifold.batch_boolean([base_manifold, tool_manifold], m.OpType.Subtract)
    return _extract_mesh(result, "subtract")


def intersect(
    meshes: List[Tuple[np.ndarray, np.ndarray]]
) -> Tuple[np.ndarray, np.ndarray]:
    """Boolean intersection; keeps only the volume shared by all inputs."""
    if len(meshes) < 2:
        raise ManifoldError("Intersection requires at least 2 meshes")

    for i, (v, t) in enumerate(meshes):
        _validate_mesh(v, t, f"mesh {i + 1} in intersect")

    manifolds = [_to_manifold(v, t) for v, t in meshes]
    result = m.Manifold.batch_boolean(manifolds, m.OpType.Intersect)
    return _extract_mesh(result, "intersect")


def solidify(
    vertices: np.ndarray,
    tri_indices: np.ndarray
) -> Tuple[np.ndarray, np.ndarray]:
    """Make a non-watertight mesh into a valid watertight solid.

    Tries, in order: dedupe exact-duplicate triangles (compacting the vertex
    buffer), then snap vertices at decreasing precision (3/2/1 decimals) with
    an explicit tolerance scaled to the bounding box and merge open edges.
    Raises ManifoldError if no strategy produces a valid solid.
    """
    vertices = np.asarray(vertices, dtype=np.float64)
    tri_indices = np.asarray(tri_indices, dtype=np.uint32)

    # Bounding-box size sets the merge tolerance scale
    bbox_min = vertices.min(axis=0)
    bbox_max = vertices.max(axis=0)
    bbox_size = (bbox_max - bbox_min).max() if (bbox_max != bbox_min).any() else 1.0

    # Drop exact-duplicate triangles (same index triple, same order)
    unique_triangles = np.unique(tri_indices, axis=0)
    removed_dups = len(tri_indices) - len(unique_triangles)
    tri_indices = unique_triangles

    if removed_dups > 0:
        # Compact the vertex buffer down to what the surviving triangles reference
        referenced = np.unique(tri_indices)
        vertex_map = np.zeros(vertices.shape[0], dtype=np.int64)
        vertex_map[referenced] = np.arange(len(referenced))  # remap indices into compact space
        tri_indices = vertex_map[tri_indices].astype(np.uint32)
        vertices = vertices[referenced]

    # Escalate snap precision: 0.001 -> 0.01 -> 0.1 until the mesh closes up
    for decimals in [3, 2, 1]:
        rounded_vertices = np.round(vertices, decimals=decimals).astype(np.float32)

        # Tolerance tracks model scale (0.1% of bbox extent, floored at 1e-6)
        tolerance = max(bbox_size * 0.001, 1e-6)

        mesh = m.Mesh(rounded_vertices, tri_indices, tolerance=float(tolerance))
        mesh.merge()

        manifold = m.Manifold(mesh)
        status = manifold.status()

        if status == m.Error.NoError and manifold.num_tri() > 0:
            return _extract_mesh(manifold)

    # Every strategy exhausted; surface the last status code for diagnosis
    raise ManifoldError(
        f"Solidify failed with error code: {status}. "
        f"This mesh may have self-intersections, non-watertight geometry, "
        f"or other issues that cannot be automatically fixed. "
        f"Try importing a different file or checking the model in 3D software."
    )


def hollow(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    wall_thickness: float = 2.0
) -> Tuple[np.ndarray, np.ndarray]:
    """Hollow out a solid to the given wall thickness by subtracting a center-scaled inner shell from the outer one."""
    vertices = np.asarray(vertices, dtype=np.float32)
    tri_indices = np.asarray(tri_indices, dtype=np.uint32)

    # Bounding box gives the center and per-axis extents to scale from
    bbox_min = vertices.min(axis=0)
    bbox_max = vertices.max(axis=0)
    center = (bbox_min + bbox_max) / 2.0
    size = bbox_max - bbox_min

    # Guard against a zero-extent mesh before computing the shrink
    min_dim = min(size)
    if min_dim == 0:
        raise ManifoldError("Mesh has zero extent in one or more dimensions")

    # Shrink each axis by 2x the wall thickness - material on both sides of every face
    inner_size = size - 2 * wall_thickness
    if inner_size.min() <= 0:
        raise ManifoldError(
            f"Wall thickness ({wall_thickness}) is too large for mesh "
            f"(minimum dimension: {min_dim:.2f})"
        )

    scale_factor = inner_size / size

    # Apply the per-axis shrink about the bbox center
    scaled_verts = (vertices - center) * scale_factor + center

    outer_manifold = _to_manifold(vertices, tri_indices)
    inner_manifold = _to_manifold(scaled_verts, tri_indices)

    # Outer minus inner leaves a closed hollow shell
    result = m.Manifold.batch_boolean(
        [outer_manifold, inner_manifold], m.OpType.Subtract
    )

    return _extract_mesh(result)


def cut_by_plane(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    normal: Tuple[float, float, float] = (0.0, 0.0, 1.0),
    origin_offset: float = 0.0
) -> List[Tuple[np.ndarray, np.ndarray]]:
    """Split a mesh along a plane (normal + offset); returns the non-empty pieces, positive side first."""
    manifold = _to_manifold(vertices, tri_indices)
    result = manifold.split_by_plane(normal, origin_offset)

    piece_a = _extract_mesh(result[0], "cut by plane") if result[0].num_tri() > 0 else None
    piece_b = _extract_mesh(result[1], "cut by plane") if result[1].num_tri() > 0 else None

    pieces = []
    if piece_a:
        pieces.append(piece_a)
    if piece_b:
        pieces.append(piece_b)

    if not pieces:
        raise ManifoldError("Cut produced no valid mesh pieces")

    # ColliBoy
    return pieces


def scale_mesh(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    factor: Tuple[float, float, float] = (1.0, 1.0, 1.0)
) -> Tuple[np.ndarray, np.ndarray]:
    """Scale a mesh by per-axis factors about the origin."""
    vertices = np.asarray(vertices, dtype=np.float32)
    factor_arr = np.array(factor, dtype=np.float32)
    scaled = vertices * factor_arr
    return scaled, tri_indices.copy()


def rotate_mesh(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    angle_degrees: float = 0.0,
    axis: str = 'z'
) -> Tuple[np.ndarray, np.ndarray]:
    """Rotate a mesh about its bounding-box center around x/y/z; positive angles are counter-clockwise."""
    vertices = np.asarray(vertices, dtype=np.float32)
    angle_rad = math.radians(angle_degrees)

    # Rotate about the bbox center: shift to origin first
    bbox_min = vertices.min(axis=0)
    bbox_max = vertices.max(axis=0)
    center = (bbox_min + bbox_max) / 2.0
    centered_vertices = vertices - center

    if axis.lower() == 'x':
        cos_a, sin_a = math.cos(angle_rad), math.sin(angle_rad)
        rotated = centered_vertices.copy()
        rotated[:, 1] = cos_a * centered_vertices[:, 1] - sin_a * centered_vertices[:, 2]
        rotated[:, 2] = sin_a * centered_vertices[:, 1] + cos_a * centered_vertices[:, 2]
    elif axis.lower() == 'y':
        cos_a, sin_a = math.cos(angle_rad), math.sin(angle_rad)
        rotated = centered_vertices.copy()
        rotated[:, 0] = cos_a * centered_vertices[:, 0] + sin_a * centered_vertices[:, 2]
        rotated[:, 2] = -sin_a * centered_vertices[:, 0] + cos_a * centered_vertices[:, 2]
    elif axis.lower() == 'z':
        cos_a, sin_a = math.cos(angle_rad), math.sin(angle_rad)
        rotated = centered_vertices.copy()
        rotated[:, 0] = cos_a * centered_vertices[:, 0] - sin_a * centered_vertices[:, 1]
        rotated[:, 1] = sin_a * centered_vertices[:, 0] + cos_a * centered_vertices[:, 1]
    else:
        raise ManifoldError(f"Unknown rotation axis: {axis}")

    # Shift back so the mesh keeps its original placement
    result = rotated + center

    return result, tri_indices.copy()


def translate_mesh(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    translation: Tuple[float, float, float] = (0.0, 0.0, 0.0)
) -> Tuple[np.ndarray, np.ndarray]:
    """Translate a mesh by a (dx, dy, dz) offset."""
    vertices = np.asarray(vertices, dtype=np.float32)
    trans = np.array(translation, dtype=np.float32)
    return vertices + trans, tri_indices.copy()


def transform_mesh(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    matrix: List[float]
) -> Tuple[np.ndarray, np.ndarray]:
    """Bake an arbitrary 4x4 affine transform into the mesh.

    Accepts Three.js Matrix4.elements directly (flat 16 floats, column-major),
    so frontend gizmo edits can be committed to stored vertex data instead of
    leaving the backend operating on stale pre-drag geometry. A negative linear
    determinant (mirror / negative scale) flips triangle winding to keep normals
    outward - otherwise later booleans silently misbehave on an inside-out solid.

    Raises ManifoldError if the matrix is not a valid 16-element list or its
    linear part is degenerate (zero/near-zero determinant).
    """
    if matrix is None or len(matrix) != 16:
        raise ManifoldError("matrix must be a flat list of 16 numbers (Three.js Matrix4.elements)")

    try:
        mat = np.array(matrix, dtype=np.float64).reshape((4, 4), order='F')
    except (ValueError, TypeError):
        raise ManifoldError("matrix must contain 16 numeric values")

    linear = mat[:3, :3]
    det = np.linalg.det(linear)
    if abs(det) < 1e-12:
        raise ManifoldError(
            "Transform is degenerate (zero or near-zero scale) and would "
            "collapse the mesh to zero volume"
        )

    vertices = np.asarray(vertices, dtype=np.float64)
    ones = np.ones((vertices.shape[0], 1), dtype=np.float64)
    homogeneous = np.hstack([vertices, ones])  # (N, 4)
    transformed = (mat @ homogeneous.T).T[:, :3]

    tri_indices = np.asarray(tri_indices, dtype=np.uint32).copy()
    if det < 0:
        # Negative determinant = mirror: swap a vertex pair in each triangle to restore outward winding
        tri_indices[:, [1, 2]] = tri_indices[:, [2, 1]]

    return transformed.astype(np.float32), tri_indices


def simplify_mesh(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    tolerance: float = 0.01
) -> Tuple[np.ndarray, np.ndarray]:
    """Reduce triangle count via manifold's built-in simplifier.

    Retries at progressively gentler tolerances if the result comes back empty;
    falls back to returning the input unchanged if every attempt fails.
    """
    manifold = _to_manifold(vertices, tri_indices)
    
    # If a tolerance eats the whole mesh, retry at gentler values
    fallback_tolerances = [tolerance * 0.5, 0.1, 0.05, 0.02]
    
    for t in [tolerance] + fallback_tolerances:
        try:
            result = manifold.simplify(t)
            return _extract_mesh(result)
        except ManifoldError as e:
            if "empty mesh" not in str(e).lower():
                raise
    
    # Nothing worked; hand back the input untouched rather than an empty result
    return vertices.copy(), tri_indices.copy()


def smooth_mesh(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    iterations: int = 1
) -> Tuple[np.ndarray, np.ndarray]:
    """Smooth vertex positions over `iterations` passes of manifold's smoothing."""
    mesh = _to_mesh(vertices, tri_indices)
    result_manifold = m.Manifold.smooth(mesh)

    for _ in range(iterations - 1):
        new_verts, new_tris = _extract_mesh(result_manifold)
        mesh = _to_mesh(new_verts, new_tris)
        result_manifold = m.Manifold.smooth(mesh)

    return _extract_mesh(result_manifold)


def fillet_mesh(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    radius: float = 1.0,
    segments: int = 3
) -> Tuple[np.ndarray, np.ndarray]:
    """Round convex edges by radius (smooth curved profile)."""
    try:
        return _round_edges(vertices, tri_indices, radius, segments, mode='fillet')
    except ManifoldError:
        raise
    except Exception as e:
        raise ManifoldError(f"Fillet failed: {str(e)}")


def chamfer_mesh(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    distance: float = 1.0,
    segments: int = 1
) -> Tuple[np.ndarray, np.ndarray]:
    """Bevel convex edges by distance (flat/faceted profile)."""
    try:
        return _round_edges(vertices, tri_indices, distance, segments, mode='chamfer')
    except ManifoldError:
        raise
    except Exception as e:
        raise ManifoldError(f"Chamfer failed: {str(e)}")


def _round_edges(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    amount: float,
    segments: int,
    mode: str
) -> Tuple[np.ndarray, np.ndarray]:
    """Round or bevel the convex edges of a solid.

    Implemented as a morphological opening - Minkowski difference followed by
    Minkowski sum with one small convex tool - which removes sharp outward
    corners while leaving concave edges and the rest of the surface untouched,
    and stays watertight because both steps are real manifold booleans rather
    than hand-stitched geometry. Fillet uses a sphere (smooth curve); chamfer
    requests 4 segments so manifold's subdivided-octahedron "sphere" degenerates
    to flat facets.
    """
    if amount <= 0:
        return vertices.copy(), tri_indices.copy()

    _validate_mesh(vertices, tri_indices, context=f"{mode} input")
    manifold = _to_manifold(vertices, tri_indices)

    # Cap the tool size just under half the smallest bbox extent, or the erosion pass could swallow the entire solid
    bbox_min, bbox_max, _ = get_bounding_box(vertices)
    extent = (bbox_max - bbox_min).astype(np.float64)
    positive_extent = extent[extent > 1e-9]
    min_extent = float(positive_extent.min()) if positive_extent.size else 0.0
    max_safe_amount = min_extent * 0.49 if min_extent > 0 else float(amount)

    clamped_amount = float(min(amount, max_safe_amount)) if max_safe_amount > 0 else 0.0
    if clamped_amount <= 1e-9:
        raise ManifoldError(
            f"{mode.capitalize()} amount ({amount:.3g}) is too large for this "
            f"object's smallest dimension. Try a smaller value."
        )

    segments = max(1, int(segments))
    if mode == 'fillet':
        # Fillet: sphere tool - manifold rounds segment counts to factors of 4, clamped to a sane range
        circular_segments = max(8, min(64, segments * 4))
    else:
        # Chamfer: at 4 segments manifold's "sphere" is just the base octahedron (flat facets); more segments = finer bevel
        circular_segments = max(4, min(64, segments * 4))

    tool = m.Manifold.sphere(clamped_amount, circular_segments)

    eroded = manifold.minkowski_difference(tool)
    if eroded.is_empty():
        raise ManifoldError(
            f"{mode.capitalize()} amount ({amount:.3g}) is too large for this "
            f"object's geometry - it would erase thin features. Try a smaller value."
        )

    result = eroded.minkowski_sum(tool)

    if result.status() != m.Error.NoError or result.is_empty():
        raise ManifoldError(
            f"{mode.capitalize()} produced invalid geometry. Try a smaller "
            f"{'radius' if mode == 'fillet' else 'distance'} or fewer segments."
        )

    return _extract_mesh(result, mode)


def get_bounding_box(
    vertices: np.ndarray
) -> Tuple[np.ndarray, np.ndarray, float]:
    """Return (min_corner, max_corner, diagonal_size) for a vertex cloud."""
    vertices = np.asarray(vertices, dtype=np.float32)
    bbox_min = vertices.min(axis=0)
    bbox_max = vertices.max(axis=0)
    diagonal = np.linalg.norm(bbox_max - bbox_min)
    return bbox_min, bbox_max, float(diagonal)


def get_mesh_stats(
    vertices: np.ndarray,
    tri_indices: Optional[np.ndarray] = None
) -> dict:
    """Summarize a mesh: vertex/triangle counts, bbox corners, dimensions, diagonal, and approximate surface area when indices are given."""
    vertices = np.asarray(vertices, dtype=np.float32)
    num_vertices = len(vertices)

    if tri_indices is not None:
        num_triangles = len(tri_indices)
    else:
        num_triangles = num_vertices // 3

    bbox_min, bbox_max, diagonal = get_bounding_box(vertices)
    dimensions = bbox_max - bbox_min

    # Surface area from the cross product of each triangle's edges
    if tri_indices is not None and len(tri_indices) > 0:
        v0 = vertices[tri_indices[:, 0]]
        v1 = vertices[tri_indices[:, 1]]
        v2 = vertices[tri_indices[:, 2]]
        edge1 = v1 - v0
        edge2 = v2 - v0
        cross = np.cross(edge1, edge2)
        surface_area = 0.5 * np.linalg.norm(cross, axis=1).sum()
    else:
        surface_area = 0.0

    return {
        'num_vertices': int(num_vertices),
        'num_triangles': int(num_triangles),
        'bbox_min': bbox_min.tolist(),
        'bbox_max': bbox_max.tolist(),
        'dimensions': dimensions.tolist(),
        'diagonal': round(diagonal, 4),
        'surface_area': round(float(surface_area), 4),
    }


# ── Primitives ─────────────────────────────────────────────────────────────

def create_cube(
    size: Tuple[float, float, float] = (1.0, 1.0, 1.0),
    centered: bool = False
) -> Tuple[np.ndarray, np.ndarray]:
    """Cube of the given size; optionally centered at origin."""
    manifold = m.Manifold.cube(size=size, center=centered)
    return _extract_mesh(manifold)


def create_sphere(
    radius: float = 1.0,
    segments: int = 0
) -> Tuple[np.ndarray, np.ndarray]:
    """Sphere of the given radius; segments=0 lets manifold pick the resolution."""
    manifold = m.Manifold.sphere(radius=radius, circular_segments=segments)
    return _extract_mesh(manifold)


def create_cylinder(
    height: float = 1.0,
    radius_bottom: float = 1.0,
    radius_top: Optional[float] = None,
    segments: int = 0,
    centered: bool = False
) -> Tuple[np.ndarray, np.ndarray]:
    """Cylinder along Z (cone when top and bottom radii differ); optionally centered at origin."""
    if radius_top is None:
        radius_top = radius_bottom

    manifold = m.Manifold.cylinder(
        height=height,
        radius_low=radius_bottom,
        radius_high=radius_top,
        circular_segments=segments,
        center=centered
    )
    return _extract_mesh(manifold)


def create_cone(
    height: float = 1.0,
    radius: float = 1.0,
    segments: int = 0,
    centered: bool = False
) -> Tuple[np.ndarray, np.ndarray]:
    """Cone along Z - a cylinder with zero top radius; optionally centered at origin."""
    manifold = m.Manifold.cylinder(
        height=height,
        radius_low=radius,
        radius_high=0.0,
        circular_segments=segments,
        center=centered
    )
    return _extract_mesh(manifold)


def create_egg(
    radius: float = 1.0,
    height: float = 2.0,
    segments: int = 0,
    centered: bool = True
) -> Tuple[np.ndarray, np.ndarray]:
    """Egg-shaped ovoid: wider, rounder bottom and narrower, pointed top.

    Manifold has no egg primitive, so the unit sphere's tessellation is reshaped
    by a smooth per-vertex radial scale that varies with height - continuous and
    fold-free, so topology survives; the result is re-wrapped through
    _to_manifold to confirm it is still a valid watertight solid.

    radius: max cross-section radius at the widest point; height: pole-to-pole
    total; segments=0 = auto resolution (same convention as create_sphere);
    centered=False sits the egg on the Z=0 plane with its bottom pole at Z=0.
    """
    sphere = m.Manifold.sphere(radius=1.0, circular_segments=segments)
    verts, tris = _extract_mesh(sphere)
    verts = verts.astype(np.float64, copy=True)

    z = verts[:, 2]  # -1..+1 across the unit sphere
    # Asymmetry factor: kept well under 1.0 so the profile never pinches closed away from the poles
    asymmetry = 1.0 + 0.28 * (-z)
    verts[:, 0] *= radius * asymmetry
    verts[:, 1] *= radius * asymmetry
    verts[:, 2] *= height / 2.0

    if not centered:
        verts[:, 2] += height / 2.0

    manifold = _to_manifold(verts.astype(np.float32), tris)
    return _extract_mesh(manifold, "egg")


def detect_overhangs(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    build_direction: Tuple[float, float, float] = (0.0, 1.0, 0.0),
    overhang_angle_degrees: float = 45.0
) -> dict:
    """Flag faces that would overhang in FDM printing.

    Compares each face normal against the build direction; faces tilting past
    overhang_angle_degrees (default 45) need support material. Returns a dict
    with overhang_indices, per-triangle overhang_colors (red = overhang, green
    = supported), max_overhang_angle, overhang_count, and overhang_ratio.
    """
    vertices = np.asarray(vertices, dtype=np.float64)
    tri_indices = np.asarray(tri_indices, dtype=np.uint32)
    num_triangles = len(tri_indices)

    if num_triangles == 0:
        return {
            'overhang_indices': np.array([], dtype=np.uint32),
            'overhang_colors': np.zeros((num_triangles, 3), dtype=np.float32),
            'max_overhang_angle': 0.0,
            'overhang_count': 0,
            'overhang_ratio': 0.0,
        }

    # Normalize the build direction; fall back to +Y if it is degenerate
    bd = np.array(build_direction, dtype=np.float64)
    bd_norm = np.linalg.norm(bd)
    if bd_norm < 1e-10:
        bd = np.array([0.0, 1.0, 0.0], dtype=np.float64)
    else:
        bd = bd / bd_norm

    v0 = vertices[tri_indices[:, 0]]
    v1 = vertices[tri_indices[:, 1]]
    v2 = vertices[tri_indices[:, 2]]
    edge1 = v1 - v0
    edge2 = v2 - v0
    face_normals = np.cross(edge1, edge2)

    norms = np.linalg.norm(face_normals, axis=1, keepdims=True)
    valid_mask = norms.flatten() > 1e-10
    face_normals[valid_mask] /= norms[valid_mask]

    dot_products = np.sum(face_normals * bd[np.newaxis, :], axis=1)
    dot_products = np.clip(dot_products, -1.0, 1.0)
    angles_from_vertical = np.degrees(np.arccos(dot_products))

    # Only outward-facing faces can overhang; flag those past the threshold
    threshold_rad = math.radians(overhang_angle_degrees)
    is_overhang = (angles_from_vertical > threshold_rad) & (dot_products > 0)

    overhang_indices = np.where(is_overhang)[0]
    max_angle = float(np.max(angles_from_vertical)) if len(overhang_indices) > 0 else 0.0

    # Paint each triangle: red = needs support, green = self-supporting
    colors = np.zeros((num_triangles, 3), dtype=np.float32)
    supported_mask = ~is_overhang & (norms.flatten() > 1e-10)
    overhang_color = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    supported_color = np.array([0.0, 1.0, 0.0], dtype=np.float32)

    colors[is_overhang] = overhang_color
    colors[supported_mask & ~is_overhang] = supported_color

    return {
        'overhang_indices': overhang_indices.astype(np.uint32),
        'overhang_colors': colors,
        'max_overhang_angle': round(max_angle, 2),
        'overhang_count': int(len(overhang_indices)),
        'overhang_ratio': round(float(len(overhang_indices)) / num_triangles, 4),
    }


def compute_thickness_map(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    min_thickness: float = 0.1,
    max_thickness: float = 10.0
) -> dict:
    """Estimate local wall thickness per face and build heatmap colors.

    Ray-casts from each face center along its normal in both directions to the
    nearest opposing surface; faces are color-coded blue (thin) through red
    (thick). Returns a dict with face_colors, vertex_colors (averaged from
    incident faces), and min/max/mean_face_thickness.
    """
    vertices = np.asarray(vertices, dtype=np.float64)
    tri_indices = np.asarray(tri_indices, dtype=np.uint32)
    num_triangles = len(tri_indices)

    if num_triangles == 0:
        return {
            'face_colors': np.zeros((num_triangles, 3), dtype=np.float32),
            'vertex_colors': np.zeros_like(vertices, dtype=np.float32),
            'min_face_thickness': 0.0,
            'max_face_thickness': 0.0,
            'mean_face_thickness': 0.0,
        }

    v0 = vertices[tri_indices[:, 0]]
    v1 = vertices[tri_indices[:, 1]]
    v2 = vertices[tri_indices[:, 2]]
    face_centers = (v0 + v1 + v2) / 3.0

    edge1 = v1 - v0
    edge2 = v2 - v0
    face_normals_raw = np.cross(edge1, edge2)
    norms = np.linalg.norm(face_normals_raw, axis=1, keepdims=True)
    valid_mask = norms.flatten() > 1e-10

    face_normals = np.zeros_like(face_centers)
    face_normals[valid_mask] = face_normals_raw[valid_mask] / norms[valid_mask]

    # Flip any inward-facing normals: for a closed solid, center dot normal should be positive
    total_divergence = np.sum(face_centers * face_normals, axis=1)
    flip_mask = total_divergence < 0
    face_normals[flip_mask] *= -1.0

    # Cast a ray from each face center along ±normal and record the closest hit on another face
    thicknesses = np.zeros(num_triangles, dtype=np.float64)

    for i in range(num_triangles):
        origin = face_centers[i]
        normal = face_normals[i]

        max_dist = float(np.linalg.norm(vertices.max(axis=0) - vertices.min(axis=0))) * 2.0
        min_hit_dist = max_dist

        # Probe both sides of the face - thickness is the nearer opposing hit
        for sign in [1.0, -1.0]:
            direction = normal * sign
            for j in range(num_triangles):
                if i == j:
                    continue

                t0 = v0[j]
                t1 = v1[j]
                t2 = v2[j]
                e1 = t1 - t0
                e2 = t2 - t0
                n = np.cross(direction, e2)
                det = np.dot(e1, n)

                if abs(det) < 1e-10:
                    continue

                det = 1.0 / det
                d = origin - t0
                t = det * np.dot(d, n)

                if t < 1e-6 or t > max_dist:
                    continue

                intersection = origin + direction * t
                u = det * np.dot(d, np.cross(direction, e1))
                v_param = det * np.dot(e2, n)

                if 0.0 <= u <= 1.0 and 0.0 <= v_param <= 1.0 - u:
                    # Skip grazing hits - near-parallel faces give unreliable thickness readings
                    cos_angle = np.dot(normal, direction)
                    if abs(cos_angle) > 0.95:
                        continue

                    hit_dist = t
                    if hit_dist < min_hit_dist:
                        min_hit_dist = hit_dist

        thicknesses[i] = min_hit_dist if min_hit_dist < max_dist else 0.0

    # Clamp into the [min, max] window used by the color ramp
    thicknesses = np.clip(thicknesses, min_thickness, max_thickness)

    # Map normalized thickness onto a blue -> cyan -> green -> yellow -> red ramp
    normalized = (thicknesses - min_thickness) / max(max_thickness - min_thickness, 1e-10)

    face_colors = np.zeros((num_triangles, 3), dtype=np.float32)
    for i in range(num_triangles):
        t = float(normalized[i])
        if t < 0.25:
            face_colors[i] = [0.0, t * 4.0, 1.0]                      # blue -> cyan
        elif t < 0.5:
            face_colors[i] = [0.0, 1.0, 1.0 - (t - 0.25) * 4.0]        # cyan -> green
        elif t < 0.75:
            face_colors[i] = [(t - 0.5) * 4.0, 1.0, 0.0]               # green -> yellow
        else:
            face_colors[i] = [1.0, 1.0 - (t - 0.75) * 4.0, 0.0]        # yellow -> red

    # Blend face colors onto their vertices (each vertex averages its incident faces)
    vertex_colors = np.zeros((len(vertices), 3), dtype=np.float32)
    vertex_counts = np.zeros(len(vertices), dtype=np.int64)
    for i in range(num_triangles):
        for vi in range(3):
            idx = int(tri_indices[i, vi])
            vertex_colors[idx] += face_colors[i]
            vertex_counts[idx] += 1

    valid_verts = vertex_counts > 0
    vertex_colors[valid_verts] /= vertex_counts[valid_verts, np.newaxis].astype(np.float32)

    return {
        'face_colors': face_colors,
        'vertex_colors': vertex_colors.astype(np.float32),
        'min_face_thickness': float(max(0.0, thicknesses.min())),
        'max_face_thickness': float(thicknesses.max()),
        'mean_face_thickness': float(thicknesses.mean()),
    }


def compute_lod_levels(
    vertices: np.ndarray,
    tri_indices: np.ndarray,
    levels: int = 3
) -> dict:
    """Generate progressively simplified LOD versions of a mesh.

    Level 0 is the input as-is; each later level targets half the original
    triangle count per step (clamped to at least 5%, minimum 10 faces), met by
    one light simplify pass kept only when it fits the face budget. Returns a
    dict with lod_levels,
    original_faces, and target_ratios.
    """
    vertices = np.asarray(vertices, dtype=np.float32)
    tri_indices = np.asarray(tri_indices, dtype=np.uint32)
    original_faces = len(tri_indices)

    if original_faces == 0:
        return {
            'lod_levels': [],
            'original_faces': 0,
            'target_ratios': [],
        }

    lod_levels = []
    current_verts = vertices.copy()
    current_tris = tri_indices.copy()

    for level in range(levels):
        ratio = max(1.0 / (2 ** level), 0.05)
        target_faces = max(int(original_faces * ratio), 10)

        if level == 0:
            # Level 0 = input as-is
            lod_levels.append({
                'vertices': current_verts.flatten().tolist(),
                'indices': current_tris.flatten().tolist(),
                'face_count': len(current_tris),
                'level': 0,
            })
        else:
            current_faces = len(current_tris)
            if current_faces <= target_faces:
                # Target already met; carry the mesh forward unchanged
                lod_levels.append({
                    'vertices': current_verts.flatten().tolist(),
                    'indices': current_tris.flatten().tolist(),
                    'face_count': current_faces,
                    'level': level,
                })
            else:
                # Simplify once at a light tolerance; adopt it only if it fits the face budget
                try:
                    simplified_verts, simplified_tris = simplify_mesh(
                        current_verts, current_tris, 0.01
                    )
                    if len(simplified_tris) <= target_faces:
                        current_verts = simplified_verts
                        current_tris = simplified_tris
                except Exception:
                    # Simplify failed; keep the mesh as-is for this level
                    pass

                lod_levels.append({
                    'vertices': current_verts.flatten().tolist(),
                    'indices': current_tris.flatten().tolist(),
                    'face_count': len(current_tris),
                    'level': level,
                })

        # Pre-simplify so each subsequent level starts from a lighter mesh
        if level < levels - 1:
            try:
                next_verts, next_tris = simplify_mesh(
                    current_verts, current_tris, 0.02
                )
                current_verts = next_verts
                current_tris = next_tris
            except Exception:
                # Simplify failed; reuse the current mesh for the rest
                pass

    target_ratios = [max(1.0 / (2 ** i), 0.05) for i in range(levels)]

    return {
        'lod_levels': lod_levels,
        'original_faces': original_faces,
        'target_ratios': target_ratios,
    }


def create_torus(
    major_radius: float = 1.0,
    minor_radius: float = 0.3,
    major_segments: int = 24,
    minor_segments: int = 12
) -> Tuple[np.ndarray, np.ndarray]:
    """Torus (donut) built from an exact signed-distance function via manifold's level_set."""
    # Manifold's level_set treats positive as inside (opposite of graphics SDF
    # convention), so negate the exact torus distance; the zero crossing is unchanged.
    def torus_sdf(x: float, y: float, z: float) -> float:
        r_xy = math.sqrt(x**2 + y**2)
        return -(math.sqrt((r_xy - major_radius) ** 2 + z**2) - minor_radius)

    bounds = [
        -major_radius - minor_radius,
        -major_radius - minor_radius,
        -minor_radius,
        major_radius + minor_radius,
        major_radius + minor_radius,
        minor_radius,
    ]

    # Derive a tessellation step from the requested segment counts
    avg_segments = (major_segments + minor_segments) / 2
    circumference = 2 * math.pi * major_radius
    edge_length = circumference / avg_segments

    manifold = m.Manifold.level_set(torus_sdf, bounds, edgeLength=edge_length)
    return _extract_mesh(manifold)
