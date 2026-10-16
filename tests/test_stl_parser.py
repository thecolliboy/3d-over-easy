"""Unit tests for the STL parser (binary and ASCII variants)."""
# ColliBoy

import io
import struct
import pytest
import numpy as np

from app.parsers.stl_parser import (
    parse_stl,
    parse_binary_stl,
    parse_ascii_stl,
    detect_stl_format,
    write_binary_stl,
    write_ascii_stl,
    write_stl,
    compute_normals_from_vertices,
    StlParseError,
)


# binary stl coverage

def _make_binary_stl(num_triangles: int, start_x: float = 0.0) -> bytes:
    """Build a minimal binary STL payload of collinear triangles."""
    header = b'Binary STL test file\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'
    header = header[:80].ljust(80, b'\x00')

    buf = io.BytesIO()
    buf.write(header)
    buf.write(struct.pack('<I', num_triangles))

    for i in range(num_triangles):
        # fixed normal pointing along +x
        buf.write(struct.pack('<fff', 1.0, 0.0, 0.0))
        # triangles step 2 units apart along x
        x = start_x + i * 2.0
        buf.write(struct.pack('<fff', x, 0.0, 0.0))
        buf.write(struct.pack('<fff', x + 1.0, 1.0, 0.0))
        buf.write(struct.pack('<fff', x + 2.0, 0.0, 0.0))
        buf.write(struct.pack('<H', 0))  # reserved two-byte attribute count slot

    return buf.getvalue()


def test_detect_binary_stl():
    """Detection classifies generated binary payloads as binary."""
    data = _make_binary_stl(5)
    assert detect_stl_format(data) == 'binary'


def test_parse_binary_single_triangle():
    """A single triangle yields three vertices and its normal."""
    data = _make_binary_stl(1)
    vertices, normals = parse_binary_stl(data)

    assert vertices.shape == (3, 3)
    assert normals.shape == (3, 3)
    assert np.allclose(normals[0], [1.0, 0.0, 0.0])


def test_parse_binary_multiple_triangles():
    """Vertex and normal arrays scale with the triangle count."""
    num_tris = 100
    data = _make_binary_stl(num_tris)
    vertices, normals = parse_binary_stl(data)

    assert vertices.shape == (num_tris * 3, 3)
    assert normals.shape == (num_tris * 3, 3)


def test_parse_binary_round_trip():
    """A generated binary payload survives the generic parse entry point."""
    num_tris = 50
    data = _make_binary_stl(num_tris)
    vertices, _ = parse_stl(data)

    assert len(vertices) == num_tris * 3


def test_parse_binary_too_small():
    """Payloads shorter than the header plus count raise StlParseError."""
    with pytest.raises(StlParseError, match="too small"):
        parse_binary_stl(b'STL' + b'\x00' * 10)


# ascii stl coverage

# ColliBoy
def _make_ascii_stl(num_triangles: int = 3) -> bytes:
    """Build a minimal ASCII STL document of collinear facets."""
    lines = ['solid test']

    for i in range(num_triangles):
        x = i * 2.0
        lines.append(f'facet normal 1.0 0.0 0.0')
        lines.append('  outer loop')
        lines.append(f'    vertex {x} 0.0 0.0')
        lines.append(f'    vertex {x + 1.0} 1.0 0.0')
        lines.append(f'    vertex {x + 2.0} 0.0 0.0')
        lines.append('  endloop')
        lines.append('endfacet')

    lines.append('endsolid test')
    return '\n'.join(lines).encode('ascii')


def test_detect_ascii_stl():
    """Detection classifies generated ASCII documents as ascii."""
    data = _make_ascii_stl()
    assert detect_stl_format(data) == 'ascii'


def test_parse_ascii_basic():
    """ASCII documents decode to the expected vertex and normal counts."""
    num_tris = 3
    data = _make_ascii_stl(num_tris)
    vertices, normals = parse_ascii_stl(data)

    assert vertices.shape == (num_tris * 3, 3)
    assert normals.shape == (num_tris * 3, 3)


def test_parse_ascii_round_trip():
    """A generated ASCII document survives the generic parse entry point."""
    num_tris = 20
    data = _make_ascii_stl(num_tris)
    vertices, _ = parse_stl(data)

    assert len(vertices) == num_tris * 3


def test_parse_ascii_empty():
    """A solid document with no facets raises StlParseError."""
    data = b'solid empty\nendsolid empty'
    with pytest.raises(StlParseError, match="No vertices"):
        parse_ascii_stl(data)


# auto-detection via parse_stl

def test_parse_auto_detect_binary():
    """parse_stl routes binary payloads to the binary decoder."""
    data = _make_binary_stl(10)
    vertices, _ = parse_stl(data)
    assert len(vertices) == 30


def test_parse_auto_detect_ascii():
    """parse_stl routes ASCII documents to the text decoder."""
    data = _make_ascii_stl(7)
    vertices, _ = parse_stl(data)
    assert len(vertices) == 21


# writer coverage

def test_write_binary_stl_flat_vertices():
    """Flat vertex lists without indices serialize to a decodable binary payload."""
    num_tris = 5
    vertices = np.random.rand(num_tris * 3, 3).astype(np.float32)
    data = write_binary_stl(vertices)

    # the written payload must decode back cleanly
    parsed_vertices, _ = parse_binary_stl(data)
    assert len(parsed_vertices) == num_tris * 3


def test_write_binary_stl_with_indices():
    """Indexed vertex lists serialize with shared corners intact."""
    vertices = np.array([
        [0, 0, 0], [1, 0, 0], [0, 1, 0],  # first triangle corners
        [1, 0, 0], [2, 0, 0], [1, 1, 0],   # second triangle corners
    ], dtype=np.float32)
    tri_indices = np.array([[0, 1, 2], [3, 4, 5]], dtype=np.uint32)

    data = write_binary_stl(vertices, tri_indices=tri_indices)
    parsed_vertices, _ = parse_binary_stl(data)

    assert len(parsed_vertices) == 6


def test_write_ascii_stl():
    """ASCII output contains the full solid/facet/vertex structure."""
    vertices = np.array([
        [0, 0, 0], [1, 0, 0], [0, 1, 0],
    ], dtype=np.float32)

    data = write_ascii_stl(vertices)
    text = data.decode('ascii')

    assert 'solid mesh' in text
    assert 'facet normal' in text
    assert 'vertex' in text
    assert 'endsolid mesh' in text


def test_write_stl_default_binary():
    """write_stl emits binary format when no variant is requested."""
    vertices = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float32)

    data = write_stl(vertices)
    assert detect_stl_format(data) == 'binary'


def test_write_stl_ascii():
    """write_stl with binary=False emits an ASCII document."""
    vertices = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float32)

    data = write_stl(vertices, binary=False)
    assert detect_stl_format(data) == 'ascii'


def test_write_binary_invalid_vertex_count():
    """Vertex counts not divisible by three are rejected at write time."""
    vertices = np.array([[0, 0, 0], [1, 0, 0]], dtype=np.float32)  # two corners cannot form a triangle

    with pytest.raises(StlParseError, match="divisible by 3"):
        write_binary_stl(vertices)


# normal recomputation coverage

def test_compute_normals_from_vertices():
    """Face normals derive from the edge cross product of vertex positions."""
    # right-angle triangle lying in the xy plane
    vertices = np.array([
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
    ], dtype=np.float32)

    tri_indices = np.array([[0, 1, 2]], dtype=np.uint32)
    normals = compute_normals_from_vertices(vertices, tri_indices)

    assert normals.shape == (3, 3)
    # edge cross product yields the +z face normal
    expected_normal = np.array([0.0, 0.0, 1.0], dtype=np.float32)

    for i in range(3):
        assert np.allclose(normals[i], expected_normal, atol=1e-5)


def test_compute_normals_multiple_triangles():
    """Normals stay consistent across multiple faces of one mesh."""
    # two triangles tiling a unit square in the xy plane
    vertices = np.array([
        [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0],   # first half of the square
        [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],   # second half of the square
    ], dtype=np.float32)

    tri_indices = np.array([
        [0, 1, 2],
        [3, 4, 5],
    ], dtype=np.uint32)

    normals = compute_normals_from_vertices(vertices, tri_indices)
    assert normals.shape == (6, 3)

    # every face normal points along +z
    for i in range(0, 6, 3):
        assert np.allclose(normals[i], [0.0, 0.0, 1.0], atol=1e-5)


# malformed and degenerate inputs

def test_parse_empty_data():
    """Empty payloads raise StlParseError."""
    with pytest.raises(StlParseError):
        parse_stl(b'')


def test_parse_garbage_data():
    """Declared triangle counts exceeding the payload are rejected."""
    header = b'\x00' * 80
    buf = bytearray(header)
    buf.extend(struct.pack('<I', 1))  # declares one triangle
    buf.extend(b'\x00' * 10)  # payload too short to hold it

    with pytest.raises(StlParseError, match="size mismatch"):
        parse_binary_stl(bytes(buf))


def test_parse_ascii_with_comments():
    """Comment lines inside an ASCII document are skipped during parsing."""
    data = b'''solid with comments
# This is a comment
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
endsolid with comments'''

    vertices, _ = parse_ascii_stl(data)
    assert len(vertices) == 3


def test_parse_binary_large_file():
    """Large binary payloads decode completely with the expected dtype."""
    num_tris = 10000
    data = _make_binary_stl(num_tris)
    vertices, _ = parse_stl(data)

    assert len(vertices) == num_tris * 3
    assert vertices.dtype == np.float32


def test_write_and_parse_preserves_shape():
    """Round-trips through write and parse preserve the vertex count."""
    for num_tris in [1, 5, 50, 500]:
        vertices = np.random.rand(num_tris * 3, 3).astype(np.float32)
        data = write_binary_stl(vertices)
        parsed_vertices, _ = parse_stl(data)
        assert len(parsed_vertices) == num_tris * 3, f"Failed for {num_tris} triangles"
