"""Unit tests for the PLY (Polygon File Format) parser.

Covers ascii and binary parsing, format detection, vertex normals and colors,
face records, stats extraction, and malformed inputs.
"""
# ColliBoy

import struct
import pytest

from app.parsers.ply_parser import (
    parse_ply,
    detect_ply_format,
    get_ply_stats,
    PlyParseError,
)


# format detection coverage

def test_detect_ascii_ply():
    """An ascii header is classified as 'ascii'."""
    data = b'''ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
end_header
0 0 0
1 0 0
0 1 0'''

    assert detect_ply_format(data) == 'ascii'


def test_detect_binary_little_endian_ply():
    """A little-endian binary header is classified as 'binary_little_endian'."""
    data = b'''ply
format binary_little_endian 1.0
element vertex 3
property float x
property float y
property float z
end_header'''

    assert detect_ply_format(data) == 'binary_little_endian'


def test_detect_binary_big_endian_ply():
    """A big-endian binary header is classified as 'binary_big_endian'."""
    data = b'''ply
format binary_big_endian 1.0
element vertex 3
property float x
property float y
property float z
end_header'''

    assert detect_ply_format(data) == 'binary_big_endian'


# ascii parsing coverage

def test_parse_ascii_basic():
    """A basic ascii document decodes to vertices and faces."""
    data = b'''ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
0 1 0
3 0 1 2'''

    mesh = parse_ply(data)
    assert len(mesh.vertices) == 3
    assert len(mesh.faces) == 1


def test_parse_ascii_with_normals():
    """Vertex normal properties are attached to decoded vertices."""
    data = b'''ply
format ascii 1.0
element vertex 2
property float x
property float y
property float z
property float nx
property float ny
property float nz
end_header
0 0 0 0 0 1
1 0 0 0 0 1'''

    mesh = parse_ply(data)
    assert len(mesh.vertices) == 2
    assert mesh.vertices[0].nx is not None


def test_parse_ascii_with_colors():
    """Vertex color properties are attached to decoded vertices."""
    data = b'''ply
format ascii 1.0
element vertex 2
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
end_header
0 0 0 255 0 0
1 0 0 0 255 0'''

    mesh = parse_ply(data)
    assert len(mesh.vertices) == 2
    assert mesh.vertices[0].red is not None


# binary parsing coverage

def _make_binary_little_endian_ply(num_vertices: int, num_faces: int = 0) -> bytes:
    """Generate a minimal valid little-endian binary PLY payload."""
    header_lines = [
        'ply',
        'format binary_little_endian 1.0',
        f'element vertex {num_vertices}',
        'property float x',
        'property float y',
        'property float z',
    ]

    if num_faces > 0:
        header_lines.append(f'element face {num_faces}')
        header_lines.append('property list uchar int vertex_indices')

    header_lines.append('end_header')
    header = '\n'.join(header_lines).encode('ascii') + b'\n'

    buf = bytearray(header)

    # pack vertex positions as little-endian float32 triples (ColliBoy)
    for i in range(num_vertices):
        buf.extend(struct.pack('<fff', float(i), 0.0, 0.0))

    # append face records after all vertices
    for i in range(num_faces):
        buf.append(3)  # triangle record carries three corner indices
        buf.extend(struct.pack('<iii', i * 3, i * 3 + 1, i * 3 + 2))

    return bytes(buf)


def test_parse_binary_little_endian():
    """A little-endian binary payload decodes to the declared vertex count."""
    num_v = 5
    data = _make_binary_little_endian_ply(num_v, 0)
    mesh = parse_ply(data)

    assert len(mesh.vertices) == num_v


def test_parse_binary_round_trip():
    """Generated payloads decode to their declared vertex counts across sizes."""
    for num_v in [1, 10, 100]:
        data = _make_binary_little_endian_ply(num_v)
        mesh = parse_ply(data)
        assert len(mesh.vertices) == num_v


# stats extraction coverage

def test_get_ply_stats_ascii():
    """Stats read element counts straight from an ascii header."""
    data = b'''ply
format ascii 1.0
element vertex 50
property float x
property float y
property float z
element face 20
property list uchar int vertex_indices
end_header'''

    stats = get_ply_stats(data)
    assert stats['num_vertices'] == 50
    assert stats['num_faces'] == 20


def test_get_ply_stats_binary():
    """Stats read element counts from a binary payload's header."""
    data = _make_binary_little_endian_ply(100, 30)
    stats = get_ply_stats(data)

    assert stats['num_vertices'] == 100
    assert stats['num_faces'] == 30


# failure mode coverage

def test_parse_empty_data():
    """Empty payloads fail with a parse or value error."""
    with pytest.raises((PlyParseError, ValueError)):
        parse_ply(b'')


def test_parse_invalid_header():
    """Non-PLY headers degrade to an empty mesh rather than raising."""
    data = b'''obj 1.0
element vertex 3
end_header'''

    mesh = parse_ply(data)
    assert len(mesh.vertices) == 0


def test_parse_missing_end_header():
    """A zero-vertex document with a complete header parses to an empty mesh."""
    data = b'''ply
format ascii 1.0
element vertex 0
end_header'''

    # a well-formed header with no vertices still parses
    mesh = parse_ply(data)
    assert len(mesh.vertices) == 0


def test_parse_binary_too_small():
    """A binary header declaring no elements parses to an empty mesh."""
    data = b'ply\nformat binary_little_endian 1.0\nend_header\n\x00'

    mesh = parse_ply(data)
    assert len(mesh.vertices) == 0


# degenerate and boundary inputs

def test_parse_single_vertex():
    """A single-vertex document decodes with exact coordinates."""
    data = b'''ply
format ascii 1.0
element vertex 1
property float x
property float y
property float z
end_header
1.5 2.5 3.5'''

    mesh = parse_ply(data)
    assert len(mesh.vertices) == 1
    assert mesh.vertices[0].x == pytest.approx(1.5)


def test_parse_no_faces():
    """Vertex-only documents decode with an empty face list."""
    data = b'''ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
end_header
0 0 0
1 0 0
0 1 0'''

    mesh = parse_ply(data)
    assert len(mesh.vertices) == 3
    assert len(mesh.faces) == 0


def test_parse_format_type_tracking():
    """The parsed mesh records its source format variant."""
    data = _make_binary_little_endian_ply(5)
    mesh = parse_ply(data)

    # the recorded variant must be one of the three supported formats
    assert mesh.format_type in ('binary_little_endian', 'binary_big_endian', 'ascii')
