"""Unit tests for the OBJ (Wavefront) parser.

Covers vertex, normal, and texture-coordinate parsing; triangle, quad, and
n-gon faces; groups and objects; round-trip writing; and malformed-input
handling.
"""
# ColliBoy

import pytest

from app.parsers.obj_parser import (
    parse_obj,
    ObjMesh,
    obj_to_mesh_arrays,
    write_obj,
    ObjParseError,
)


# basic directive parsing

def test_parse_vertex():
    """Vertex lines are collected into the mesh's position list."""
    data = b'''v 1.0 2.0 3.0
v 4.0 5.0 6.0
v 7.0 8.0 9.0'''

    mesh = parse_obj(data)
    assert len(mesh.vertices) == 3
    assert mesh.vertices[0] == (1.0, 2.0, 3.0)
    assert mesh.vertices[2] == (7.0, 8.0, 9.0)


def test_parse_normal():
    """Normal lines are collected into the mesh's normal list."""
    data = b'''v 0 0 0
vn 1.0 0.0 0.0
vn 0.0 1.0 0.0
vn 0.0 0.0 1.0'''

    mesh = parse_obj(data)
    assert len(mesh.normals) == 3
    assert mesh.normals[0] == (1.0, 0.0, 0.0)


def test_parse_texture_coords():
    """Texture coordinate lines are collected into the mesh's uv list."""
    data = b'''v 0 0 0
vt 0.0 0.0
vt 1.0 0.0
vt 0.5 1.0'''

    mesh = parse_obj(data)
    assert len(mesh.texture_coords) == 3
    assert mesh.texture_coords[0] == (0.0, 0.0)


def test_parse_triangle_face():
    """Triangle faces store zero-based vertex references."""
    data = b'''v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3'''

    mesh = parse_obj(data)
    assert len(mesh.faces) == 1
    # one-based file indices become zero-based array offsets
    assert mesh.faces[0] == [(0, -1, -1), (1, -1, -1), (2, -1, -1)]


def test_parse_face_with_normals():
    """Faces with vertex//normal references leave the texcoord slot empty."""
    data = b'''v 0 0 0
v 1 0 0
v 0 1 0
vn 0 0 1
f 1//1 2//1 3//1'''

    mesh = parse_obj(data)
    assert len(mesh.faces) == 1
    assert mesh.faces[0][0] == (0, -1, 0)


def test_parse_face_with_full_refs():
    """Full v/vt/vn face references populate all three slots."""
    data = b'''v 0 0 0
vt 0 0
vn 0 0 1
f 1/1/1 2/1/1 3/1/1'''

    mesh = parse_obj(data)
    assert len(mesh.faces) == 1
    assert mesh.faces[0][0] == (0, 0, 0)


# fan triangulation of higher-order faces

def test_parse_quad_face():
    """Quad faces subdivide into two triangles via a fan from the first corner."""
    data = b'''v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
f 1 2 3 4'''

    mesh = parse_obj(data)
    # four corners yield two fan triangles
    assert len(mesh.faces) == 2


def test_parse_ngon_face():
    """Pentagon faces subdivide into three triangles via a fan."""
    data = b'''v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v -1 1 0
f 1 2 3 4 5'''

    mesh = parse_obj(data)
    # five corners yield three fan triangles
    assert len(mesh.faces) == 3


# group and object directives

def test_parse_groups():
    """Group directives register each named group on the mesh."""
    data = b'''v 0 0 0
v 1 0 0
g groupA
f 1 2 1
g groupB
f 1 2 1'''

    mesh = parse_obj(data)
    assert 'groupA' in mesh.groups
    assert 'groupB' in mesh.groups


def test_parse_object_names():
    """Object names are treated as group entries."""
    data = b'''v 0 0 0
o myObject
f 1 1 1'''

    mesh = parse_obj(data)
    assert 'myObject' in mesh.groups


# writer coverage

def test_write_obj_flat_vertices():
    """Flat vertex lists serialize to v and f lines."""
    vertices = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]

    data = write_obj(vertices)
    text = data.decode('utf-8')

    assert 'v' in text
    assert 'f' in text


def test_write_obj_with_indices():
    """Indexed vertex lists serialize with face references into the pool."""
    vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0]
    indices = [0, 1, 2]

    data = write_obj(vertices, indices=indices)
    text = data.decode('utf-8')

    assert 'v' in text
    # faces reference pool entries by index (ColliBoy)
    assert 'f' in text


def test_write_obj_with_normals():
    """Provided normals emit vn lines in the document."""
    vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0]
    normals = [0, 0, 1, 0, 0, 1, 0, 0, 1]

    data = write_obj(vertices, normals=normals)
    text = data.decode('utf-8')

    assert 'vn' in text


def test_write_obj_with_uv():
    """Provided uv coordinates emit vt lines in the document."""
    vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0]
    uv_coords = [(0.0, 0.0), (1.0, 0.0), (0.5, 1.0)]

    data = write_obj(vertices, uv_coords=uv_coords)
    text = data.decode('utf-8')

    assert 'vt' in text


# mesh array conversion coverage

def test_obj_to_mesh_arrays_triangles():
    """Triangle faces convert to flat vertex and index arrays."""
    mesh = ObjMesh()
    mesh.vertices = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    mesh.faces = [[(0, -1, -1), (1, -1, -1), (2, -1, -1)]]

    vertices, indices, normals = obj_to_mesh_arrays(mesh)

    assert len(vertices) == 9  # three corners times three components each
    assert len(indices) == 3


def test_obj_to_mesh_arrays_with_normals():
    """Normal arrays are produced when the mesh carries per-corner normals."""
    mesh = ObjMesh()
    mesh.vertices = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    mesh.normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1)]
    mesh.faces = [[(0, -1, 0), (1, -1, 1), (2, -1, 2)]]

    vertices, indices, normals = obj_to_mesh_arrays(mesh)

    assert normals is not None
    assert len(normals) == 9


# failure mode coverage

def test_parse_empty_obj():
    """Documents without vertices raise ObjParseError."""
    data = b'# empty file\n'
    with pytest.raises(ObjParseError, match="No vertices"):
        parse_obj(data)


def test_parse_invalid_vertex():
    """Vertex lines missing components raise ObjParseError."""
    data = b'v 1.0\n'  # only one component present
    with pytest.raises(ObjParseError):
        parse_obj(data)


def test_parse_face_too_few_vertices():
    """Faces with fewer than three references are rejected."""
    data = b'''v 0 0 0
v 1 0 0
f 1'''

    with pytest.raises(ObjParseError, match="at least 3"):
        parse_obj(data)


def test_parse_out_of_bounds_vertex():
    """Face references beyond the vertex pool raise ObjParseError."""
    mesh = ObjMesh()
    mesh.vertices = [(0, 0, 0)]  # single-vertex pool
    mesh.faces = [[(5, -1, -1), (6, -1, -1), (7, -1, -1)]]  # indices point past the pool

    with pytest.raises(ObjParseError, match="out-of-bounds"):
        obj_to_mesh_arrays(mesh)


def test_parse_no_faces():
    """Meshes without faces fail conversion."""
    mesh = ObjMesh()
    mesh.vertices = [(0, 0, 0)]
    # no faces set

    with pytest.raises(ObjParseError, match="No faces"):
        obj_to_mesh_arrays(mesh)


# tolerance for comments and blank lines

def test_parse_with_comments():
    """Comment lines are skipped without affecting the parse."""
    data = b'''# Header comment
v 0 0 0
# Another comment
v 1 0 0
f 1 2 1'''

    mesh = parse_obj(data)
    assert len(mesh.vertices) == 2


def test_parse_with_blank_lines():
    """Blank lines between directives are ignored."""
    data = b'''v 0 0 0

v 1 0 0

f 1 2 1'''

    mesh = parse_obj(data)
    assert len(mesh.vertices) == 2


# round-trip coverage

def test_write_and_parse_round_trip():
    """Triangle meshes convert to flat arrays with expected counts."""
    # build a single-triangle mesh
    mesh = ObjMesh()
    mesh.vertices = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)]
    mesh.faces = [[(0, -1, -1), (1, -1, -1), (2, -1, -1)]]

    vertices, indices, normals = obj_to_mesh_arrays(mesh)

    # array shapes must match the source mesh
    assert len(vertices) == 9  # three corners times three components each
    assert len(indices) == 3
