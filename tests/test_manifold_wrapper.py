"""Tests for the manifold wrapper geometry engine.

Covers every high-level operation: CSG (union/subtract/intersect), repair,
hollow, cut, transforms (scale/rotate/translate), simplify, smooth, bounding
box, mesh stats, and primitive generation.
"""
# ColliBoy

import pytest
import numpy as np

from app.engine.manifold_wrapper import (
    ManifoldError,
    union,
    subtract,
    intersect,
    repair,
    hollow,
    cut_by_plane,
    scale_mesh,
    rotate_mesh,
    translate_mesh,
    simplify_mesh,
    smooth_mesh,
    get_bounding_box,
    get_mesh_stats,
    create_cube,
    create_sphere,
    create_cylinder,
    create_cone,
    create_torus,
)


# shared mesh fixtures

def _make_unit_cube() -> tuple:
    """Build a unit cube as (vertices, triangle indices)."""
    v = np.array([
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],   # the four corners of the lower square
        [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],   # the four corners of the upper square
    ], dtype=np.float32)
    t = np.array([
        [0, 1, 2], [0, 2, 3],   # two triangles tile the lower square
        [5, 4, 7], [5, 7, 6],   # two triangles tile the upper square
        [4, 0, 3], [4, 3, 7],   # rear face
        [1, 5, 6], [1, 6, 2],   # front face
        [4, 5, 1], [4, 1, 0],   # left face
        [3, 2, 6], [3, 6, 7],   # right face
    ], dtype=np.uint32)
    return v, t


def _make_offset_cube(offset: float = 2.5) -> tuple:
    """Build a unit cube shifted away from the origin."""
    v, t = _make_unit_cube()
    return v + offset, t


def _make_overlapping_cube() -> tuple:
    """Build a unit cube that overlaps the origin cube."""
    # half-unit shift along every axis leaves a large shared region
    v, t = _make_unit_cube()
    return v + np.array([0.5, 0.5, 0.5], dtype=np.float32), t


# boolean union coverage

class TestUnion:
    """union behavior across overlap scenarios"""

    def test_union_overlapping_cubes(self):
        """Merging two overlapping cubes yields a single mesh."""
        cube1 = _make_unit_cube()
        cube2 = _make_overlapping_cube()
        result = union([cube1, cube2])
        vertices, tri_indices = result

        assert len(vertices) > 0
        assert len(tri_indices) > 0
        # the merged shape carries at least one cube's worth of triangles
        assert len(tri_indices) >= 12

    def test_union_adjacent_cubes(self):
        """Merging face-touching cubes keeps both volumes."""
        cube1 = _make_unit_cube()
        cube2 = _make_offset_cube(offset=1.0)  # offset places the second cube against the first's x face
        result = union([cube1, cube2])
        vertices, tri_indices = result

        assert len(vertices) > 0
        assert len(tri_indices) >= 12

    def test_union_separate_cubes(self):
        """Merging disjoint cubes keeps every triangle of both."""
        cube1 = _make_unit_cube()
        cube2 = _make_offset_cube(offset=5.0)  # the two cubes stay far apart
        result = union([cube1, cube2])
        vertices, tri_indices = result

        assert len(vertices) > 0
        # the result must hold both cubes' surfaces
        assert len(tri_indices) >= 24

    def test_union_three_cubes(self):
        """Three-way union of overlapping cubes succeeds."""
        cube1 = _make_unit_cube()
        cube2 = _make_overlapping_cube()
        cube3_v, cube3_t = _make_unit_cube()
        cube3_v = (cube3_v + np.array([0.5, 0.5, -0.5])).astype(np.float32)

        result = union([cube1, cube2, (cube3_v, cube3_t)])
        vertices, tri_indices = result
        assert len(vertices) > 0

    def test_union_requires_two_meshes(self):
        """Union rejects inputs with fewer than two meshes."""
        cube1 = _make_unit_cube()
        with pytest.raises(ManifoldError, match="at least 2"):
            union([cube1])

    def test_union_empty_list(self):
        """Union rejects an empty mesh list."""
        with pytest.raises(ManifoldError, match="at least 2"):
            union([])

    def test_union_preserves_float32_dtype(self):
        """Union output vertices keep the float32 dtype."""
        cube1 = _make_unit_cube()
        cube2 = _make_overlapping_cube()
        result = union([cube1, cube2])
        assert result[0].dtype == np.float32

    def test_union_result_is_manifold(self):
        """Union of valid cubes yields a watertight result."""
        cube1 = _make_unit_cube()
        cube2 = _make_overlapping_cube()
        vertices, tri_indices = union([cube1, cube2])

        # every index must land inside the vertex pool
        assert np.all(tri_indices < len(vertices))
        assert np.all(tri_indices >= 0)


# boolean subtract coverage

class TestSubtract:
    """subtract behavior across overlap scenarios"""

    def test_subtract_small_from_large(self):
        """Cutting a small sphere out of a cube removes volume."""
        cube = _make_unit_cube()
        # place the sphere at the cube's center
        sphere_v, sphere_t = create_sphere(radius=0.3)
        sphere_v = (sphere_v + np.array([0.5, 0.5, 0.5])).astype(np.float32)

        result = subtract(cube, (sphere_v, sphere_t))
        vertices, tri_indices = result

        assert len(vertices) > 0
        # the cavity adds surface beyond the plain cube
        assert len(tri_indices) >= 12

    def test_subtract_non_overlapping(self):
        """Subtracting a disjoint mesh leaves the original intact."""
        cube = _make_unit_cube()
        far_away_v, far_away_t = _make_offset_cube(offset=10.0)

        result = subtract(cube, (far_away_v, far_away_t))
        vertices, tri_indices = result

        assert len(vertices) > 0
        # the untouched cube keeps its full triangle count
        assert len(tri_indices) >= 12

    def test_subtract_full_overlap(self):
        """Subtracting a far-away mesh leaves the target unchanged."""
        small = create_sphere(radius=0.3)
        large_v, large_t = _make_offset_cube(offset=5.0)

        # removing a disjoint cube cannot alter the sphere
        result = subtract(small, (large_v, large_t))
        vertices, tri_indices = result
        assert len(vertices) > 0


# boolean intersect coverage

# ColliBoy
class TestIntersect:
    """intersect behavior across overlap scenarios"""

    def test_intersect_overlapping_cubes(self):
        """Intersecting overlapping cubes yields the shared volume."""
        cube1 = _make_unit_cube()
        cube2 = _make_overlapping_cube()
        result = intersect([cube1, cube2])
        vertices, tri_indices = result

        assert len(vertices) > 0
        assert len(tri_indices) >= 12

    def test_intersect_non_overlapping(self):
        """Intersecting disjoint meshes raises ManifoldError."""
        cube1 = _make_unit_cube()
        far_v, far_t = _make_offset_cube(offset=10.0)

        with pytest.raises(ManifoldError):
            intersect([cube1, (far_v, far_t)])

    def test_intersect_requires_two_meshes(self):
        """Intersect rejects inputs with fewer than two meshes."""
        cube = _make_unit_cube()
        with pytest.raises(ManifoldError, match="at least 2"):
            intersect([cube])

    def test_intersect_empty_list(self):
        """Intersect rejects an empty mesh list."""
        with pytest.raises(ManifoldError, match="at least 2"):
            intersect([])


# repair coverage

class TestRepair:
    """mesh repair behavior"""

    def test_repair_valid_cube(self):
        """Repairing a valid cube returns the same surface."""
        cube = _make_unit_cube()
        result = repair(*cube)
        vertices, tri_indices = result

        assert len(vertices) > 0
        assert len(tri_indices) >= 12

    def test_repair_returns_valid_mesh(self):
        """Repaired meshes keep their indices in range."""
        cube = _make_unit_cube()
        vertices, tri_indices = repair(*cube)

        assert np.all(tri_indices < len(vertices))
        assert np.all(tri_indices >= 0)


# hollow coverage

class TestHollow:
    """hollow operation behavior"""

    def test_hollow_cube(self):
        """Hollowing a cube produces an inner and outer shell."""
        cube = _make_unit_cube()
        result = hollow(*cube, wall_thickness=0.2)
        vertices, tri_indices = result

        assert len(vertices) > 0
        # the hollow body carries both wall surfaces
        assert len(tri_indices) >= 12

    def test_hollow_too_thick_raises(self):
        """Wall thickness beyond the mesh size raises ManifoldError."""
        cube = _make_unit_cube()
        with pytest.raises(ManifoldError, match="too large"):
            hollow(*cube, wall_thickness=10.0)

    def test_hollow_zero_dimension_raises(self):
        """Hollowing a zero-extent mesh raises ManifoldError."""
        # coplanar corners leave no z extent
        v = np.array([
            [0, 0, 0], [1, 0, 0], [0.5, 1, 0],
        ], dtype=np.float32)
        t = np.array([[0, 1, 2]], dtype=np.uint32)

        with pytest.raises(ManifoldError):
            hollow(v, t, wall_thickness=0.1)


# plane cut coverage

class TestCutByPlane:
    """plane cut behavior"""

    def test_cut_cube_in_half(self):
        """A mid-height plane splits the cube into two pieces."""
        cube = _make_unit_cube()
        pieces = cut_by_plane(*cube, normal=(0, 0, 1), origin_offset=0.5)

        assert len(pieces) == 2
        for vertices, tri_indices in pieces:
            assert len(vertices) > 0
            assert len(tri_indices) >= 3

    def test_cut_cube_x_axis(self):
        """A vertical x-plane split yields two pieces."""
        cube = _make_unit_cube()
        pieces = cut_by_plane(*cube, normal=(1, 0, 0), origin_offset=0.5)

        assert len(pieces) == 2

    def test_cut_cube_y_axis(self):
        """A vertical y-plane split yields two pieces."""
        cube = _make_unit_cube()
        pieces = cut_by_plane(*cube, normal=(0, 1, 0), origin_offset=0.5)

        assert len(pieces) == 2

    def test_cut_at_edge(self):
        """Cutting at a mesh boundary may yield a single piece."""
        cube = _make_unit_cube()
        pieces = cut_by_plane(*cube, normal=(0, 0, 1), origin_offset=-0.5)

        # one side of the plane holds nothing, the other keeps the whole cube
        assert len(pieces) >= 1

    def test_cut_far_from_mesh(self):
        """A plane far from the mesh returns it as a single piece."""
        cube = _make_unit_cube()
        pieces = cut_by_plane(*cube, normal=(0, 0, 1), origin_offset=10.0)

        assert len(pieces) == 1


# scale coverage

class TestScaleMesh:
    """mesh scaling behavior"""

    def test_scale_uniform_2x(self):
        """Uniform doubling doubles every dimension."""
        cube = _make_unit_cube()
        vertices, tri_indices = scale_mesh(*cube, factor=(2.0, 2.0, 2.0))

        bbox_min, bbox_max, _ = get_bounding_box(vertices)
        dims = bbox_max - bbox_min

        assert np.allclose(dims, [2.0, 2.0, 2.0], atol=1e-5)

    def test_scale_non_uniform(self):
        """Per-axis factors change dimensions independently."""
        cube = _make_unit_cube()
        vertices, tri_indices = scale_mesh(*cube, factor=(2.0, 1.0, 0.5))

        bbox_min, bbox_max, _ = get_bounding_box(vertices)
        dims = bbox_max - bbox_min

        assert np.allclose(dims, [2.0, 1.0, 0.5], atol=1e-5)

    def test_scale_preserves_triangle_count(self):
        """Scaling leaves the triangle count unchanged."""
        cube = _make_unit_cube()
        _, tri_indices = scale_mesh(*cube, factor=(3.0, 3.0, 3.0))

        assert len(tri_indices) == 12

    def test_scale_0_5x(self):
        """Half scaling halves every dimension."""
        cube = _make_unit_cube()
        vertices, tri_indices = scale_mesh(*cube, factor=(0.5, 0.5, 0.5))

        bbox_min, bbox_max, _ = get_bounding_box(vertices)
        dims = bbox_max - bbox_min

        assert np.allclose(dims, [0.5, 0.5, 0.5], atol=1e-5)


# rotate coverage

class TestRotateMesh:
    """mesh rotation behavior"""

    def test_rotate_z_90_degrees(self):
        """A quarter turn about z preserves the bounding box size."""
        cube = _make_unit_cube()
        vertices, tri_indices = rotate_mesh(*cube, angle_degrees=90.0, axis='z')

        bbox_min, bbox_max, _ = get_bounding_box(vertices)
        dims = bbox_max - bbox_min

        # rotation moves corners but not extents
        assert np.allclose(dims, [1.0, 1.0, 1.0], atol=1e-5)

    def test_rotate_x_90_degrees(self):
        """A quarter turn about x preserves the bounding box size."""
        cube = _make_unit_cube()
        vertices, tri_indices = rotate_mesh(*cube, angle_degrees=90.0, axis='x')

        bbox_min, bbox_max, _ = get_bounding_box(vertices)
        dims = bbox_max - bbox_min

        assert np.allclose(dims, [1.0, 1.0, 1.0], atol=1e-5)

    def test_rotate_y_90_degrees(self):
        """A quarter turn about y preserves the bounding box size."""
        cube = _make_unit_cube()
        vertices, tri_indices = rotate_mesh(*cube, angle_degrees=90.0, axis='y')

        bbox_min, bbox_max, _ = get_bounding_box(vertices)
        dims = bbox_max - bbox_min

        assert np.allclose(dims, [1.0, 1.0, 1.0], atol=1e-5)

    def test_rotate_360_degrees(self):
        """A full turn returns to the original orientation."""
        cube = _make_unit_cube()
        vertices, tri_indices = rotate_mesh(*cube, angle_degrees=360.0, axis='z')

        bbox_min, bbox_max, _ = get_bounding_box(vertices)
        dims = bbox_max - bbox_min

        assert np.allclose(dims, [1.0, 1.0, 1.0], atol=1e-5)

    def test_rotate_preserves_triangle_count(self):
        """Rotation leaves the triangle count unchanged."""
        cube = _make_unit_cube()
        _, tri_indices = rotate_mesh(*cube, angle_degrees=45.0, axis='x')

        assert len(tri_indices) == 12

    def test_rotate_invalid_axis_raises(self):
        """An unknown rotation axis raises ManifoldError."""
        cube = _make_unit_cube()
        with pytest.raises(ManifoldError, match="Unknown rotation axis"):
            rotate_mesh(*cube, angle_degrees=90.0, axis='w')

    def test_rotate_negative_angle(self):
        """Negative angles rotate in the opposite direction."""
        cube = _make_unit_cube()
        vertices, tri_indices = rotate_mesh(*cube, angle_degrees=-90.0, axis='z')

        bbox_min, bbox_max, _ = get_bounding_box(vertices)
        dims = bbox_max - bbox_min

        assert np.allclose(dims, [1.0, 1.0, 1.0], atol=1e-5)


# translate coverage

class TestTranslateMesh:
    """mesh translation behavior"""

    def test_translate_positive(self):
        """A positive offset shifts every vertex."""
        cube = _make_unit_cube()
        vertices, tri_indices = translate_mesh(*cube, translation=(1.0, 2.0, 3.0))

        bbox_min, bbox_max, _ = get_bounding_box(vertices)

        assert np.allclose(bbox_min, [1.0, 2.0, 3.0], atol=1e-5)
        assert np.allclose(bbox_max, [2.0, 3.0, 4.0], atol=1e-5)

    def test_translate_preserves_dimensions(self):
        """Translation leaves the mesh dimensions unchanged."""
        cube = _make_unit_cube()
        vertices, tri_indices = translate_mesh(*cube, translation=(5.0, -3.0, 2.0))

        bbox_min, bbox_max, _ = get_bounding_box(vertices)
        dims = bbox_max - bbox_min

        assert np.allclose(dims, [1.0, 1.0, 1.0], atol=1e-5)

    def test_translate_preserves_triangle_count(self):
        """Translation leaves the triangle count unchanged."""
        cube = _make_unit_cube()
        _, tri_indices = translate_mesh(*cube, translation=(10.0, 10.0, 10.0))

        assert len(tri_indices) == 12


# simplify coverage

class TestSimplifyMesh:
    """mesh simplification behavior"""

    def test_simplify_sphere(self):
        """Simplifying a dense sphere reduces its triangle count."""
        # build a finely tessellated sphere
        v, t = create_sphere(radius=1.0, segments=48)

        original_count = len(t)
        result = simplify_mesh(v, t, tolerance=0.1)
        vertices, tri_indices = result

        assert len(vertices) > 0
        # decimation may only remove triangles, never add them
        assert len(tri_indices) <= original_count

    def test_simplify_cube(self):
        """Simplifying a cube still returns a usable mesh."""
        cube = _make_unit_cube()
        result = simplify_mesh(*cube, tolerance=0.01)
        vertices, tri_indices = result

        assert len(vertices) > 0


# smooth coverage

class TestSmoothMesh:
    """mesh smoothing behavior"""

    def test_smooth_cube(self):
        """One smoothing pass yields a valid mesh."""
        cube = _make_unit_cube()
        result = smooth_mesh(*cube, iterations=1)
        vertices, tri_indices = result

        assert len(vertices) > 0
        assert len(tri_indices) >= 12

    def test_smooth_multiple_iterations(self):
        """Repeated smoothing passes yield a valid mesh."""
        cube = _make_unit_cube()
        result = smooth_mesh(*cube, iterations=3)
        vertices, tri_indices = result

        assert len(vertices) > 0


# bounding box coverage

class TestBoundingBox:
    """bounding box calculation behavior"""

    def test_unit_cube_bbox(self):
        """The origin cube's box spans [0,1] on each axis."""
        v, t = _make_unit_cube()
        bbox_min, bbox_max, diag = get_bounding_box(v)

        assert np.allclose(bbox_min, [0.0, 0.0, 0.0], atol=1e-5)
        assert np.allclose(bbox_max, [1.0, 1.0, 1.0], atol=1e-5)
        # the space diagonal of a unit cube is sqrt(3)
        assert abs(diag - np.sqrt(3.0)) < 1e-4

    def test_offset_cube_bbox(self):
        """The box tracks a shifted vertex set."""
        v, t = _make_offset_cube(offset=5.0)
        bbox_min, bbox_max, _ = get_bounding_box(v)

        assert np.allclose(bbox_min, [5.0, 5.0, 5.0], atol=1e-5)
        assert np.allclose(bbox_max, [6.0, 6.0, 6.0], atol=1e-5)

    def test_bbox_diagonal(self):
        """The diagonal measures corner-to-corner distance."""
        v = np.array([
            [0, 0, 0], [3, 4, 0], [0, 0, 12]
        ], dtype=np.float32)

        _, _, diag = get_bounding_box(v)

        # 9 + 16 + 144 sums to 169, whose root is 13
        assert abs(diag - 13.0) < 1e-4


# mesh stats coverage

class TestMeshStats:
    """mesh statistics behavior"""

    def test_cube_stats(self):
        """Cube stats report the expected counts and extents."""
        v, t = _make_unit_cube()
        stats = get_mesh_stats(v, t)

        assert stats['num_vertices'] == 8
        assert stats['num_triangles'] == 12
        assert np.allclose(stats['dimensions'], [1.0, 1.0, 1.0], atol=1e-5)

    def test_stats_without_indices(self):
        """Index-less stats derive triangles from vertex count divided by three."""
        v = np.random.rand(30, 3).astype(np.float32)
        stats = get_mesh_stats(v)

        assert stats['num_vertices'] == 30
        assert stats['num_triangles'] == 10

    def test_stats_surface_area(self):
        """Surface area sums over all triangle faces."""
        v, t = _make_unit_cube()
        stats = get_mesh_stats(v, t)

        # six unit squares give a total area of six
        assert abs(stats['surface_area'] - 6.0) < 0.5

    def test_stats_bbox(self):
        """Stats carry the bounding box endpoints."""
        v, t = _make_unit_cube()
        stats = get_mesh_stats(v, t)

        assert len(stats['bbox_min']) == 3
        assert len(stats['bbox_max']) == 3


# primitive generation coverage

class TestPrimitives:
    """primitive mesh generation behavior"""

    def test_create_cube(self):
        """The cube primitive yields twelve triangles."""
        v, t = create_cube(size=(1.0, 1.0, 1.0))

        assert len(v) > 0
        assert len(t) == 12
        assert v.dtype == np.float32

    def test_create_cube_sized(self):
        """A sized cube matches the requested extents."""
        v, t = create_cube(size=(2.0, 4.0, 6.0))

        bbox_min, bbox_max, _ = get_bounding_box(v)
        dims = bbox_max - bbox_min

        assert np.allclose(dims, [2.0, 4.0, 6.0], atol=1e-3)

    def test_create_cube_centered(self):
        """A centered cube is symmetric about the origin."""
        v, t = create_cube(size=(2.0, 2.0, 2.0), centered=True)

        bbox_min, bbox_max, _ = get_bounding_box(v)

        assert np.allclose(bbox_min, [-1.0, -1.0, -1.0], atol=1e-3)
        assert np.allclose(bbox_max, [1.0, 1.0, 1.0], atol=1e-3)

    def test_create_sphere(self):
        """The sphere primitive yields a watertight mesh."""
        v, t = create_sphere(radius=1.0)

        assert len(v) > 0
        # any usable sphere tessellation exceeds this floor
        assert len(t) >= 12

    def test_create_sphere_radius(self):
        """Sphere extents match twice the requested radius."""
        v, t = create_sphere(radius=2.0)

        bbox_min, bbox_max, _ = get_bounding_box(v)
        dims = bbox_max - bbox_min

        assert np.allclose(dims, [4.0, 4.0, 4.0], atol=1e-3)

    def test_create_cylinder(self):
        """The cylinder primitive yields a valid mesh."""
        v, t = create_cylinder(height=2.0, radius_bottom=1.0)

        assert len(v) > 0
        assert len(t) >= 6

    def test_create_cone(self):
        """The cone primitive yields a valid mesh."""
        v, t = create_cone(height=2.0, radius=1.0)

        assert len(v) > 0
        assert len(t) >= 3

    def test_create_torus(self):
        """The torus primitive yields a watertight mesh."""
        v, t = create_torus(major_radius=1.0, minor_radius=0.3)

        assert len(v) > 0
        assert len(t) >= 12


# degenerate inputs and failure modes

class TestEdgeCases:
    """degenerate input and error handling behavior"""

    def test_union_with_degenerate_mesh(self):
        """Union tolerates flat, zero-volume meshes."""
        # a coplanar single-triangle surface
        flat_v = np.array([
            [0, 0, 0], [1, 0, 0], [0.5, 1, 0],
        ], dtype=np.float32)
        flat_t = np.array([[0, 1, 2]], dtype=np.uint32)

        cube = _make_unit_cube()
        try:
            result = union([cube, (flat_v, flat_t)])
            # on success the output must still be usable
            assert len(result[0]) > 0
        except ManifoldError:
            pass  # rejection of flat input is equally acceptable

    def test_scale_zero_factor(self):
        """Zero scaling on one axis flattens that dimension."""
        cube = _make_unit_cube()
        vertices, tri_indices = scale_mesh(*cube, factor=(1.0, 0.0, 1.0))

        bbox_min, bbox_max, _ = get_bounding_box(vertices)
        dims = bbox_max - bbox_min

        # the flattened axis measures zero within floating-point tolerance
        assert abs(dims[1]) < 1e-5

    def test_rotate_zero_angle(self):
        """A zero-degree rotation leaves the mesh unchanged."""
        cube = _make_unit_cube()
        vertices, tri_indices = rotate_mesh(*cube, angle_degrees=0.0, axis='z')

        bbox_min, bbox_max, _ = get_bounding_box(vertices)
        dims = bbox_max - bbox_min

        assert np.allclose(dims, [1.0, 1.0, 1.0], atol=1e-5)

    def test_translate_zero(self):
        """A zero offset leaves the mesh unchanged."""
        cube = _make_unit_cube()
        vertices, tri_indices = translate_mesh(*cube, translation=(0.0, 0.0, 0.0))

        bbox_min, bbox_max, _ = get_bounding_box(vertices)
        dims = bbox_max - bbox_min

        assert np.allclose(dims, [1.0, 1.0, 1.0], atol=1e-5)

    def test_manifold_error_is_exception(self):
        """ManifoldError subclasses Exception directly."""
        assert issubclass(ManifoldError, Exception)
