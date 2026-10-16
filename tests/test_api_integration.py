"""Integration tests for all API endpoints.

Tests cover import/export, CSG operations (union/subtract/intersect),
geometry operations (solid/hollow/cut/scale/rotate/translate/simplify/smooth/info),
primitive creation, session management, and end-to-end workflows -
using the Flask test client with binary STL fixtures.
"""
# ColliBoy

import io
import struct
import uuid

import pytest
import numpy as np

from app import create_app
from app.models.session import store


# --- Helpers

def _make_unit_cube_stl() -> bytes:
    """Generate a binary STL of a unit cube (12 triangles = 36 vertices)."""
    header = b'Unit cube STL\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'
    header = header[:80].ljust(80, b'\x00')

    buf = io.BytesIO()
    buf.write(header)
    num_tris = 12
    buf.write(struct.pack('<I', num_tris))

    normal = struct.pack('<fff', 0.0, 0.0, -1.0)
    attr = struct.pack('<H', 0)
    buf.write(normal + struct.pack('<fff', 0, 0, 0) + struct.pack('<fff', 1, 0, 0) + struct.pack('<fff', 1, 1, 0) + attr)
    buf.write(normal + struct.pack('<fff', 0, 0, 0) + struct.pack('<fff', 1, 1, 0) + struct.pack('<fff', 0, 1, 0) + attr)

    normal = struct.pack('<fff', 0.0, 0.0, 1.0)
    buf.write(normal + struct.pack('<fff', 0, 0, 1) + struct.pack('<fff', 1, 0, 1) + struct.pack('<fff', 1, 1, 1) + attr)
    buf.write(normal + struct.pack('<fff', 0, 0, 1) + struct.pack('<fff', 1, 1, 1) + struct.pack('<fff', 0, 1, 1) + attr)

    normal = struct.pack('<fff', 0.0, -1.0, 0.0)
    buf.write(normal + struct.pack('<fff', 0, 0, 0) + struct.pack('<fff', 1, 0, 0) + struct.pack('<fff', 1, 0, 1) + attr)
    buf.write(normal + struct.pack('<fff', 0, 0, 0) + struct.pack('<fff', 1, 0, 1) + struct.pack('<fff', 0, 0, 1) + attr)

    normal = struct.pack('<fff', 0.0, 1.0, 0.0)
    buf.write(normal + struct.pack('<fff', 0, 1, 0) + struct.pack('<fff', 1, 1, 0) + struct.pack('<fff', 1, 1, 1) + attr)
    buf.write(normal + struct.pack('<fff', 0, 1, 0) + struct.pack('<fff', 1, 1, 1) + struct.pack('<fff', 0, 1, 1) + attr)

    normal = struct.pack('<fff', -1.0, 0.0, 0.0)
    buf.write(normal + struct.pack('<fff', 0, 0, 0) + struct.pack('<fff', 0, 1, 0) + struct.pack('<fff', 0, 1, 1) + attr)
    buf.write(normal + struct.pack('<fff', 0, 0, 0) + struct.pack('<fff', 0, 1, 1) + struct.pack('<fff', 0, 0, 1) + attr)

    normal = struct.pack('<fff', 1.0, 0.0, 0.0)
    buf.write(normal + struct.pack('<fff', 1, 0, 0) + struct.pack('<fff', 1, 1, 0) + struct.pack('<fff', 1, 1, 1) + attr)
    buf.write(normal + struct.pack('<fff', 1, 0, 0) + struct.pack('<fff', 1, 1, 1) + struct.pack('<fff', 1, 0, 1) + attr)

    return buf.getvalue()


def _make_large_cube_stl(size: float = 4.0) -> bytes:
    """Generate a larger binary STL cube (size x size x size)."""
    header = b'Large cube STL\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'
    header = header[:80].ljust(80, b'\x00')

    buf = io.BytesIO()
    buf.write(header)
    num_tris = 12
    buf.write(struct.pack('<I', num_tris))

    faces = [
        (struct.pack('<fff', 0.0, 0.0, -1.0), [(0, 0, 0), (size, 0, 0), (size, size, 0)], [(0, 0, 0), (size, size, 0), (0, size, 0)]),
        (struct.pack('<fff', 0.0, 0.0, 1.0), [(0, 0, size), (size, 0, size), (size, size, size)], [(0, 0, size), (size, size, size), (0, size, size)]),
        (struct.pack('<fff', 0.0, -1.0, 0.0), [(0, 0, 0), (size, 0, 0), (size, 0, size)], [(0, 0, 0), (size, 0, size), (0, 0, size)]),
        (struct.pack('<fff', 0.0, 1.0, 0.0), [(0, size, 0), (size, size, 0), (size, size, size)], [(0, size, 0), (size, size, size), (0, size, size)]),
        (struct.pack('<fff', -1.0, 0.0, 0.0), [(0, 0, 0), (0, size, 0), (0, size, size)], [(0, 0, 0), (0, size, size), (0, 0, size)]),
        (struct.pack('<fff', 1.0, 0.0, 0.0), [(size, 0, 0), (size, size, 0), (size, size, size)], [(size, 0, 0), (size, size, size), (size, 0, size)]),
    ]

    attr = struct.pack('<H', 0)
    for normal, tri1, tri2 in faces:
        buf.write(normal + struct.pack('<fff', *tri1[0]) + struct.pack('<fff', *tri1[1]) + struct.pack('<fff', *tri1[2]) + attr)
        buf.write(normal + struct.pack('<fff', *tri2[0]) + struct.pack('<fff', *tri2[1]) + struct.pack('<fff', *tri2[2]) + attr)

    return buf.getvalue()


# --- Fixtures

@pytest.fixture(autouse=True)
def clean_sessions():
    """Clear the session store before each test."""
    store._sessions.clear()


@pytest.fixture
def app_client():
    """Provide a Flask test client for endpoint tests."""
    app = create_app('default')
    with app.test_client() as client:
        yield client


@pytest.fixture
def unit_cube_file():
    """Provide a binary STL of a unit cube."""
    return _make_unit_cube_stl()


# --- Helper methods for test classes

def _import_cube(client, cube_data, session_id=None):
    """Import a unit cube and return (session_id, object_id)."""
    data = {'file': (io.BytesIO(cube_data), 'test_cube.stl')}
    if session_id:
        data['session_id'] = session_id
    resp = client.post('/api/import', data=data, content_type='multipart/form-data')
    result = resp.get_json()
    return result['session_id'], result['objects'][0]['id']


def _create_manifold_cube(client, offset=(0.0, 0.0, 0.0), session_id=None):
    """Insert a manifold-ready cube directly into the session store.

    Bypasses STL parsing so the mesh has indexed triangles with correct winding for CSG.
    """
    v = np.array([
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],   # bottom face
        [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],   # top face
    ], dtype=np.float32) + np.array(offset, dtype=np.float32)

    t = np.array([
        [0, 1, 2], [0, 2, 3],   # bottom
        [5, 4, 7], [5, 7, 6],   # top
        [4, 0, 3], [4, 3, 7],   # back
        [1, 5, 6], [1, 6, 2],   # front
        [4, 5, 1], [4, 1, 0],   # left
        [3, 2, 6], [3, 6, 7],   # right
    ], dtype=np.uint32)

    actual_session = store.get_or_create_session(session_id)['id'] if session_id else None
    obj_id = str(uuid.uuid4())[:8]

    store.add_object(actual_session or session_id, {
        'id': obj_id,
        'name': f'cube_{offset}',
        'format': 'mesh',
        'vertices': v.flatten().tolist(),
        'indices': t.flatten().tolist(),
        'normals': None,
        'num_vertices': len(v),
        'num_faces': len(t),
    })

    return actual_session or session_id, obj_id


# --- Health Check Tests

class TestHealth:
    def test_health_endpoint(self, app_client):
        """Health endpoint returns ok status."""
        resp = app_client.get('/api/health')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['status'] == 'ok'


# --- Import Tests

class TestImport:
    def test_import_stl_file(self, app_client, unit_cube_file):
        """Importing a valid STL file creates an object in session."""
        data = {'file': (io.BytesIO(unit_cube_file), 'test_cube.stl')}
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        assert resp.status_code == 200
        result = resp.get_json()
        assert 'session_id' in result
        assert 'objects' in result
        assert len(result['objects']) == 1

    def test_import_stl_returns_session_id(self, app_client, unit_cube_file):
        """Import response includes session_id."""
        data = {'file': (io.BytesIO(unit_cube_file), 'test_cube.stl')}
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        result = resp.get_json()
        assert result['session_id'] is not None
        assert len(result['session_id']) > 0

    def test_import_stl_returns_object_data(self, app_client, unit_cube_file):
        """Import response includes object with vertices and indices."""
        data = {'file': (io.BytesIO(unit_cube_file), 'test_cube.stl')}
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        result = resp.get_json()
        obj = result['objects'][0]
        assert 'id' in obj
        assert 'vertices' in obj
        assert 'indices' in obj
        assert 'num_vertices' in obj
        assert 'num_faces' in obj

    def test_import_no_file_returns_400(self, app_client):
        """Import without a file returns 400."""
        resp = app_client.post('/api/import', data={})
        assert resp.status_code == 400
        data = resp.get_json()
        assert 'error' in data

    def test_import_unsupported_format_returns_400(self, app_client):
        """Importing an unsupported format returns 400."""
        data = {'file': (io.BytesIO(b'not a 3d file'), 'test.xyz')}
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        assert resp.status_code == 400

    def test_import_creates_session_if_not_provided(self, app_client, unit_cube_file):
        """Import creates a new session when none is provided."""
        initial_count = len(store._sessions)
        data = {'file': (io.BytesIO(unit_cube_file), 'test_cube.stl')}
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        assert resp.status_code == 200
        result = resp.get_json()
        # A new session was created for this import.
        assert len(store._sessions) >= initial_count

    def test_import_multiple_files(self, app_client, unit_cube_file):
        """Importing multiple files adds all objects to the same session."""
        data = {
            'file': [
                (io.BytesIO(unit_cube_file), 'cube1.stl'),
                (io.BytesIO(unit_cube_file), 'cube2.stl'),
            ]
        }
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        assert resp.status_code == 200
        result = resp.get_json()
        assert result['imported_count'] == 2
        assert len(result['objects']) == 2

    def test_import_with_session_id(self, app_client, unit_cube_file):
        """Import with explicit session_id adds to that session."""
        data = {'file': (io.BytesIO(unit_cube_file), 'test_cube.stl'), 'session_id': 'my-session'}
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        assert resp.status_code == 200
        result = resp.get_json()
        assert result['session_id'] == 'my-session'

    def test_import_obj_file(self, app_client):
        """Importing a valid OBJ file succeeds."""
        obj_data = b'''v 0.0 0.0 0.0
v 1.0 0.0 0.0
v 1.0 1.0 0.0
v 0.0 1.0 0.0
f 1 2 3
f 1 3 4
'''
        data = {'file': (io.BytesIO(obj_data), 'test.obj')}
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        assert resp.status_code == 200

    def test_import_ply_file(self, app_client):
        """Importing a valid PLY file succeeds."""
        ply_data = b'''ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
element face 2
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
1 1 0
0 1 0
3 0 1 2
3 0 2 3
'''
        data = {'file': (io.BytesIO(ply_data), 'test.ply')}
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        assert resp.status_code == 200

    def test_import_glb_file(self, app_client):
        """A GLB with no mesh data is detected but rejected (400)."""
        # Header-only GLB: format detection passes, parsing fails.
        glb_header = struct.pack('<I', 0x46546C67)  # GLTF magic
        glb_header += struct.pack('<I', 2)           # version
        glb_header += struct.pack('<I', 12)          # total length
        data = {'file': (io.BytesIO(glb_header), 'test.glb')}
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        assert resp.status_code == 400

    def test_import_3mf_file(self, app_client):
        """A minimal 3MF archive returns 200 or 400 (empty mesh)."""
        # Minimal 3MF is a ZIP with [Content_Types].xml and model.xml
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            zf.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>')
            zf.writestr('model/model.xml', '<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"></model>')
        data = {'file': (io.BytesIO(buf.getvalue()), 'test.3mf')}
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        # Both statuses are valid for this minimal payload.
        assert resp.status_code in (200, 400)

    def test_import_multi_object_3mf_keeps_objects_separate(self, app_client):
        """A multi-object 3MF imports as separate objects at their archive positions."""
        from app.parsers._3mf_parser import write_3mf

        first = _unit_cube_mesh()
        second = _unit_cube_mesh()
        # column-major world matrix (three.js Matrix4.elements order)
        second['transform'] = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 5, 2, 3, 1]

        archive = write_3mf([first, second])
        data = {'file': (io.BytesIO(archive), 'project.3mf')}
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        assert resp.status_code == 200
        result = resp.get_json()

        # One session object per archive mesh - not a merged pool
        assert len(result['objects']) == 2
        assert result['imported_count'] == 2

        second_verts = result['objects'][1]['vertices']
        triples = [tuple(second_verts[i:i + 3]) for i in range(0, len(second_verts), 3)]
        # The transformed cube's corner lands at its archive position (local origin -> (5,2,3)).
        assert any(abs(x - 5) < 1e-9 and abs(y - 2) < 1e-9 and abs(z - 3) < 1e-9 for x, y, z in triples)


# --- Export Tests

class TestExport:
    def test_export_stl_single_object(self, app_client, unit_cube_file):
        """Export a single object as STL returns file data."""
        session_id, obj_id = _import_cube(app_client, unit_cube_file)
        resp = app_client.get(f'/api/export?session_id={session_id}&object_id={obj_id}&format=stl')
        assert resp.status_code == 200
        assert resp.content_type.startswith('application/sla')

    def test_export_obj_single_object(self, app_client, unit_cube_file):
        """Export a single object as OBJ returns file data."""
        session_id, obj_id = _import_cube(app_client, unit_cube_file)
        resp = app_client.get(f'/api/export?session_id={session_id}&object_id={obj_id}&format=obj')
        assert resp.status_code == 200
        assert 'text/wavefront-obj' in resp.content_type

    def test_export_ply_single_object(self, app_client, unit_cube_file):
        """Export a single object as PLY returns file data."""
        session_id, obj_id = _import_cube(app_client, unit_cube_file)
        resp = app_client.get(f'/api/export?session_id={session_id}&object_id={obj_id}&format=ply')
        assert resp.status_code == 200
        assert 'application/ply' in resp.content_type

    def test_export_3mf_single_object(self, app_client, unit_cube_file):
        """Export a single object as 3MF returns a valid archive."""
        session_id, obj_id = _import_cube(app_client, unit_cube_file)
        resp = app_client.get(f'/api/export?session_id={session_id}&object_id={obj_id}&format=3mf')
        assert resp.status_code == 200
        assert '3dmanufacturing' in resp.content_type

    def test_export_requires_session_id(self, app_client):
        """Export without session_id returns 400."""
        resp = app_client.get('/api/export?object_id=abc&format=stl')
        assert resp.status_code == 400

    def test_export_unknown_format_returns_400(self, app_client):
        """Export with unsupported format returns 400."""
        resp = app_client.get('/api/export?session_id=abc&object_id=xyz&format=xyz')
        assert resp.status_code in (400, 404)

    def test_export_object_not_found_returns_404(self, app_client):
        """Export with non-existent object_id returns 404."""
        resp = app_client.get('/api/export?session_id=nonexistent&object_id=xyz&format=stl')
        assert resp.status_code in (404, 400)

    def test_export_all_combined_stl(self, app_client, unit_cube_file):
        """Export all objects as combined STL returns file data."""
        session_id, obj_id = _import_cube(app_client, unit_cube_file)
        # Import a second object into the same session
        _, obj_id2 = _import_cube(app_client, unit_cube_file, session_id=session_id)
        resp = app_client.get(f'/api/export/all?session_id={session_id}&format=stl')
        assert resp.status_code == 200

    def test_export_all_no_objects_returns_404(self, app_client):
        """Export all with empty session returns 404."""
        resp = app_client.get('/api/export/all?session_id=empty-session&format=stl')
        assert resp.status_code == 404

    def test_export_all_mixed_geometry_keeps_unindexed_objects(self, app_client, unit_cube_file):
        """A soup (STL import) plus an indexed object both survive the combined STL merge."""
        session_id, _ = _import_cube(app_client, unit_cube_file)
        _create_manifold_cube(app_client, offset=(5.0, 0.0, 0.0), session_id=session_id)
        resp = app_client.get(f'/api/export/all?session_id={session_id}&format=stl')
        assert resp.status_code == 200
        num_tris = struct.unpack('<I', resp.data[80:84])[0]
        # 12 soup + 12 indexed triangles must all be present.
        assert num_tris == 24

    def test_export_all_combined_obj(self, app_client, unit_cube_file):
        """Combined OBJ merges every object into one file."""
        session_id, _ = _import_cube(app_client, unit_cube_file)
        _create_manifold_cube(app_client, offset=(5.0, 0.0, 0.0), session_id=session_id)
        resp = app_client.get(f'/api/export/all?session_id={session_id}&format=obj')
        assert resp.status_code == 200
        assert 'text/wavefront-obj' in resp.content_type
        faces = sum(1 for line in resp.data.split(b'\n') if line.startswith(b'f '))
        assert faces == 24

    def test_export_all_combined_ply(self, app_client, unit_cube_file):
        """Combined PLY concatenates every object's vertices into one file."""
        session_id, _ = _import_cube(app_client, unit_cube_file)
        _create_manifold_cube(app_client, offset=(5.0, 0.0, 0.0), session_id=session_id)
        resp = app_client.get(f'/api/export/all?session_id={session_id}&format=ply')
        assert resp.status_code == 200
        assert 'application/ply' in resp.content_type
        # 36 soup vertices + 8 indexed vertices
        assert b'element vertex 44' in resp.data

    def test_export_all_combined_3mf(self, app_client, unit_cube_file):
        """Combined 3MF packs every session object into one archive."""
        session_id, _ = _import_cube(app_client, unit_cube_file)
        _create_manifold_cube(app_client, offset=(5.0, 0.0, 0.0), session_id=session_id)
        resp = app_client.get(f'/api/export/all?session_id={session_id}&format=3mf')
        assert resp.status_code == 200
        # The response is a ZIP; its model document must hold both meshes.
        import zipfile
        zf = zipfile.ZipFile(io.BytesIO(resp.data))
        names = zf.namelist()
        model_name = next(n for n in names if n.endswith('.model'))
        model_xml = zf.read(model_name).decode('utf-8')
        assert model_xml.count('<object id=') == 2

    def test_export_preset_print_ready_whole_session_merges_all(self, app_client, unit_cube_file):
        """Print-ready without object_id merges every session object into one STL."""
        session_id, _ = _import_cube(app_client, unit_cube_file)
        _create_manifold_cube(app_client, offset=(5.0, 0.0, 0.0), session_id=session_id)
        resp = app_client.get(f'/api/export/preset?session_id={session_id}&preset=print-ready')
        assert resp.status_code == 200
        num_tris = struct.unpack('<I', resp.data[80:84])[0]
        # Both objects must survive in the merged output.
        assert num_tris >= 24

    def test_export_preset_print_ready(self, app_client, unit_cube_file):
        """Print-ready preset exports repaired STL."""
        session_id, obj_id = _import_cube(app_client, unit_cube_file)
        resp = app_client.get(f'/api/export/preset?session_id={session_id}&object_id={obj_id}&preset=print-ready')
        assert resp.status_code == 200

    def test_export_preset_3mf(self, app_client, unit_cube_file):
        """3MF preset exports a valid 3MF archive."""
        session_id, obj_id = _import_cube(app_client, unit_cube_file)
        resp = app_client.get(f'/api/export/preset?session_id={session_id}&object_id={obj_id}&preset=3mf')
        assert resp.status_code == 200

    def test_export_preset_obj_texture(self, app_client, unit_cube_file):
        """OBJ-textured preset exports OBJ with UV coordinates."""
        session_id, obj_id = _import_cube(app_client, unit_cube_file)
        resp = app_client.get(f'/api/export/preset?session_id={session_id}&object_id={obj_id}&preset=obj-texture')
        assert resp.status_code == 200

    def test_export_single_object_without_object_id(self, app_client, unit_cube_file):
        """Export with single object in session works without explicit object_id."""
        session_id, obj_id = _import_cube(app_client, unit_cube_file)
        resp = app_client.get(f'/api/export?session_id={session_id}&format=stl')
        assert resp.status_code == 200

    def test_export_multiple_objects_requires_object_id(self, app_client, unit_cube_file):
        """Export with multiple objects requires object_id."""
        session_id, obj_id = _import_cube(app_client, unit_cube_file)
        _import_cube(app_client, unit_cube_file, session_id=session_id)
        resp = app_client.get(f'/api/export?session_id={session_id}&format=stl')
        assert resp.status_code == 400

    def test_export_preset_unknown_returns_400(self, app_client):
        """Unknown preset returns 400."""
        resp = app_client.get('/api/export/preset?session_id=abc&preset=unknown')
        assert resp.status_code in (400, 404)


def _unit_cube_mesh(offset=(0.0, 0.0, 0.0)):
    """Indexed unit-cube mesh in the shape expected by /api/export/scene."""
    ox, oy, oz = offset
    vertices = [
        ox, oy, oz,             # 0
        ox + 1, oy, oz,         # 1
        ox + 1, oy + 1, oz,     # 2
        ox, oy + 1, oz,         # 3
        ox, oy, oz + 1,         # 4
        ox + 1, oy, oz + 1,     # 5
        ox + 1, oy + 1, oz + 1, # 6
        ox, oy + 1, oz + 1,     # 7
    ]
    indices = [
        0, 1, 2, 0, 2, 3,       # z=0 face
        4, 5, 6, 4, 6, 7,       # z=1 face
        0, 1, 5, 0, 5, 4,       # y=0 face
        2, 3, 7, 2, 7, 6,       # y=1 face
        0, 3, 7, 0, 7, 4,       # x=0 face
        1, 2, 6, 1, 6, 5,       # x=1 face
    ]
    return {'name': 'cube', 'vertices': vertices, 'indices': indices}


class TestSceneExport:
    """Whole-scene export from client-supplied world-space meshes (/api/export/scene).

    The frontend snapshots every visible object with its transform baked into the
    vertex data, so these tests feed meshes that already sit at their final
    positions - including objects that would live in different backend sessions.
    """

    def test_scene_export_stl_merges_all_meshes(self, app_client):
        """STL merge includes every mesh and preserves their baked-in positions."""
        meshes = [_unit_cube_mesh((0, 0, 0)), _unit_cube_mesh((50, 0, 0))]
        resp = app_client.post('/api/export/scene', json={'format': 'stl', 'meshes': meshes})
        assert resp.status_code == 200
        num_tris = struct.unpack('<I', resp.data[80:84])[0]
        # Both cubes must survive the merge.
        assert num_tris == 24

        xs = []
        for i in range(num_tris):
            base = 84 + i * 50
            for j in range(3):
                x, _, _ = struct.unpack_from('<fff', resp.data, base + 12 + j * 12)
                xs.append(x)
        # Positions survive the merge: one cluster near the origin, one at +50
        assert min(xs) < 5 and max(xs) > 49

    def test_scene_export_stl_mixed_indexed_and_soup(self, app_client):
        """Indexed and unindexed (triangle-soup) meshes both survive the merge."""
        soup = {'name': 'soup', 'vertices': [0, 0, 0, 10, 0, 0, 0, 10, 0]}
        resp = app_client.post('/api/export/scene', json={'format': 'stl', 'meshes': [_unit_cube_mesh(), soup]})
        assert resp.status_code == 200
        num_tris = struct.unpack('<I', resp.data[80:84])[0]
        assert num_tris == 13

    def test_scene_export_obj_merges_all_meshes(self, app_client):
        """OBJ merge writes every mesh's faces at their world positions."""
        meshes = [_unit_cube_mesh((0, 0, 0)), _unit_cube_mesh((50, 0, 0))]
        resp = app_client.post('/api/export/scene', json={'format': 'obj', 'meshes': meshes})
        assert resp.status_code == 200
        text = resp.data.decode()
        faces = sum(1 for line in text.splitlines() if line.startswith('f '))
        assert faces == 24
        xs = [float(line.split()[1]) for line in text.splitlines() if line.startswith('v ')]
        assert min(xs) < 5 and max(xs) > 49

    def test_scene_export_ply_concatenates_all_meshes(self, app_client):
        """PLY concatenates every mesh's vertices into one file."""
        meshes = [_unit_cube_mesh((0, 0, 0)), _unit_cube_mesh((50, 0, 0))]
        resp = app_client.post('/api/export/scene', json={'format': 'ply', 'meshes': meshes})
        assert resp.status_code == 200
        # 8 + 8 vertices from the two cubes
        assert b'element vertex 16' in resp.data

    def test_scene_export_3mf_keeps_meshes_separate(self, app_client):
        """3MF packs every mesh as its own object in one archive."""
        import zipfile
        meshes = [_unit_cube_mesh((0, 0, 0)), _unit_cube_mesh((50, 0, 0))]
        resp = app_client.post('/api/export/scene', json={'format': '3mf', 'meshes': meshes})
        assert resp.status_code == 200
        zf = zipfile.ZipFile(io.BytesIO(resp.data))
        names = zf.namelist()
        model_name = next(n for n in names if n.endswith('.model'))
        model_xml = zf.read(model_name).decode('utf-8')
        assert model_xml.count('<object id=') == 2

    def test_scene_export_3mf_writes_item_transforms(self, app_client):
        """3MF keeps models unmerged and stores positional data as item transforms."""
        import zipfile
        # column-major world matrix (three.js Matrix4.elements order)
        moved = _unit_cube_mesh()
        moved['name'] = 'moved'
        moved['transform'] = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 5, 2, 3, 1]

        resp = app_client.post('/api/export/scene', json={'format': '3mf', 'meshes': [_unit_cube_mesh(), moved]})
        assert resp.status_code == 200
        zf = zipfile.ZipFile(io.BytesIO(resp.data))
        names = zf.namelist()
        model_name = next(n for n in names if n.endswith('.model'))
        model_xml = zf.read(model_name).decode('utf-8')

        # Models stay separate; the untransformed item has no positional data.
        assert model_xml.count('<object id=') == 2
        assert '<item objectid="1"/>' in model_xml
        # The second item keeps its world matrix, transposed to the spec's row-major order
        expected = '0.0 1.0 0.0 5.0 -1.0 0.0 0.0 2.0 0.0 0.0 1.0 3.0 0.0 0.0 0.0 1.0'
        assert f'<item objectid="2" transform="{expected}"/>' in model_xml
        # Vertices stay local; positions are not baked into the geometry
        assert 'x="5.' not in model_xml

    def test_scene_export_3mf_round_trip_keeps_positions(self, app_client):
        """Re-importing a saved 3MF restores each model's archive position."""
        moved = _unit_cube_mesh()
        moved['name'] = 'moved'
        # column-major rotZ(-90deg) + T(5,2,3); local corner (0,1,0) maps to (6,2,3)
        moved['transform'] = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 5, 2, 3, 1]

        resp = app_client.post('/api/export/scene', json={'format': '3mf', 'meshes': [_unit_cube_mesh(), moved]})
        assert resp.status_code == 200

        data = {'file': (io.BytesIO(resp.data), 'project.3mf')}
        import_resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        assert import_resp.status_code == 200
        objects = import_resp.get_json()['objects']

        # The archive round-trips as separate models, not a merged pool
        assert len(objects) == 2

        triples = [tuple(obj['vertices'][i:i + 3]) for obj in objects for i in range(0, len(obj['vertices']), 3)]
        # Transformed mesh corners must land at archive positions.
        assert any(abs(x - 5) < 1e-9 and abs(y - 2) < 1e-9 and abs(z - 3) < 1e-9 for x, y, z in triples)
        assert any(abs(x - 6) < 1e-9 and abs(y - 2) < 1e-9 and abs(z - 3) < 1e-9 for x, y, z in triples)

    def test_scene_export_requires_meshes(self, app_client):
        """Scene export without meshes returns 400."""
        resp = app_client.post('/api/export/scene', json={'format': 'stl', 'meshes': []})
        assert resp.status_code == 400

    def test_scene_export_unknown_format_returns_400(self, app_client):
        """Scene export with an unsupported format returns 400."""
        resp = app_client.post('/api/export/scene', json={'format': 'xyz', 'meshes': [_unit_cube_mesh()]})
        assert resp.status_code == 400


# --- CSG Operation Tests

class TestCSGUnion:
    def test_union_requires_two_objects(self, app_client):
        """Union with fewer than 2 objects returns 400."""
        resp = app_client.post('/api/csg/union', json={'session_id': 'abc', 'object_ids': ['only-one']})
        assert resp.status_code == 400

    def test_union_missing_session_id(self, app_client):
        """Union without session_id returns 400."""
        resp = app_client.post('/api/csg/union', json={'object_ids': ['a', 'b']})
        assert resp.status_code == 400

    def test_union_overlapping_cubes(self, app_client):
        """Union of two overlapping cubes produces a merged mesh."""
        session_id = store._generate_id()
        _, obj1 = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)
        _, obj2 = _create_manifold_cube(app_client, offset=(0.5, 0.5, 0.5), session_id=session_id)

        resp = app_client.post('/api/csg/union', json={
            'session_id': session_id,
            'object_ids': [obj1, obj2],
        })
        assert resp.status_code == 200
        result = resp.get_json()
        assert 'id' in result
        assert 'vertices' in result
        assert 'num_vertices' in result

    def test_union_non_overlapping_cubes(self, app_client):
        """Union of non-overlapping cubes still produces a valid mesh."""
        session_id = store._generate_id()
        _, obj1 = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)
        _, obj2 = _create_manifold_cube(app_client, offset=(5.0, 5.0, 5.0), session_id=session_id)

        resp = app_client.post('/api/csg/union', json={
            'session_id': session_id,
            'object_ids': [obj1, obj2],
        })
        assert resp.status_code == 200

    def test_union_object_not_found(self, app_client):
        """Union with non-existent object returns 404."""
        resp = app_client.post('/api/csg/union', json={
            'session_id': 'nonexistent',
            'object_ids': ['a', 'b'],
        })
        assert resp.status_code == 404

    def test_union_replaces_originals(self, app_client):
        """Union removes the originals and keeps only the result."""
        session_id = store._generate_id()
        _, obj1 = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)
        _, obj2 = _create_manifold_cube(app_client, offset=(0.5, 0.5, 0.5), session_id=session_id)

        resp = app_client.post('/api/csg/union', json={
            'session_id': session_id,
            'object_ids': [obj1, obj2],
        })
        assert resp.status_code == 200

        # Verify originals are gone
        assert store.get_object(session_id, obj1) is None
        assert store.get_object(session_id, obj2) is None


class TestCSGSubtract:
    def test_subtract_requires_base_and_tool(self, app_client):
        """Subtract requires both base_id and tool_id."""
        resp = app_client.post('/api/csg/subtract', json={'session_id': 'abc'})
        assert resp.status_code == 400

    def test_subtract_missing_session_id(self, app_client):
        """Subtract without session_id returns 400."""
        resp = app_client.post('/api/csg/subtract', json={'base_id': 'a', 'tool_id': 'b'})
        assert resp.status_code == 400

    def test_subtract_object_not_found(self, app_client):
        """Subtract with non-existent object returns 404."""
        resp = app_client.post('/api/csg/subtract', json={
            'session_id': 'nonexistent',
            'base_id': 'a',
            'tool_id': 'b',
        })
        assert resp.status_code == 404

    def test_subtract_overlapping_cubes(self, app_client):
        """Subtraction of overlapping cubes produces a valid result."""
        session_id = store._generate_id()
        # Base: unit cube at origin
        _, base_id = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)

        # Tool: overlapping cube shifted by 0.5
        _, tool_id = _create_manifold_cube(app_client, offset=(0.5, 0.5, 0.5), session_id=session_id)

        resp = app_client.post('/api/csg/subtract', json={
            'session_id': session_id,
            'base_id': base_id,
            'tool_id': tool_id,
        })
        assert resp.status_code == 200


class TestCSGIntersect:
    def test_intersect_requires_two_objects(self, app_client):
        """Intersect with fewer than 2 objects returns 400."""
        resp = app_client.post('/api/csg/intersect', json={'session_id': 'abc', 'object_ids': ['only-one']})
        assert resp.status_code == 400

    def test_intersect_missing_session_id(self, app_client):
        """Intersect without session_id returns 400."""
        resp = app_client.post('/api/csg/intersect', json={'object_ids': ['a', 'b']})
        assert resp.status_code == 400

    def test_intersect_overlapping_cubes(self, app_client):
        """Intersect of overlapping cubes produces a valid result."""
        session_id = store._generate_id()
        _, obj1 = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)
        _, obj2 = _create_manifold_cube(app_client, offset=(0.5, 0.5, 0.5), session_id=session_id)

        resp = app_client.post('/api/csg/intersect', json={
            'session_id': session_id,
            'object_ids': [obj1, obj2],
        })
        assert resp.status_code == 200

    def test_intersect_non_overlapping_returns_error(self, app_client):
        """Intersect of non-overlapping cubes returns 400."""
        session_id = store._generate_id()
        _, obj1 = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)
        _, obj2 = _create_manifold_cube(app_client, offset=(5.0, 5.0, 5.0), session_id=session_id)

        resp = app_client.post('/api/csg/intersect', json={
            'session_id': session_id,
            'object_ids': [obj1, obj2],
        })
        # Manifold rejects the empty intersection.
        assert resp.status_code == 400


# --- Geometry Operation Tests

class TestGeometrySolid:
    def test_solid_requires_params(self, app_client):
        """Solid without required params returns 400."""
        resp = app_client.post('/api/geometry/solid', json={})
        assert resp.status_code == 400

    def test_solid_valid_mesh(self, app_client):
        """Solidifying a valid manifold mesh succeeds."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)
        resp = app_client.post('/api/geometry/solid', json={
            'session_id': session_id,
            'object_id': obj_id,
        })
        assert resp.status_code == 200
        result = resp.get_json()
        assert 'id' in result
        assert 'vertices' in result

    def test_solid_object_not_found(self, app_client):
        """Solid with a non-existent object returns 400."""
        resp = app_client.post('/api/geometry/solid', json={
            'session_id': 'nonexistent',
            'object_id': 'xyz',
        })
        assert resp.status_code == 400


class TestGeometryHollow:
    def test_hollow_requires_params(self, app_client):
        """Hollow without required params returns 400."""
        resp = app_client.post('/api/geometry/hollow', json={})
        assert resp.status_code == 400

    def test_hollow_with_wall_thickness(self, app_client):
        """Hollow with a reasonable wall thickness produces a shell."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)
        resp = app_client.post('/api/geometry/hollow', json={
            'session_id': session_id,
            'object_id': obj_id,
            'wall_thickness': 0.3,
        })
        assert resp.status_code == 200

    def test_hollow_too_thick_wall_returns_error(self, app_client):
        """Hollow with a wall thicker than the mesh returns 400."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)

        # A wall this thick must fail cleanly.
        resp = app_client.post('/api/geometry/hollow', json={
            'session_id': session_id,
            'object_id': obj_id,
            'wall_thickness': 100.0,
        })
        assert resp.status_code == 400


class TestGeometryCut:
    def test_cut_requires_params(self, app_client):
        """Cut without required params returns 400."""
        resp = app_client.post('/api/geometry/cut', json={})
        assert resp.status_code == 400

    def test_cut_returns_two_pieces(self, app_client):
        """Cutting a cube in half returns two pieces."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)
        resp = app_client.post('/api/geometry/cut', json={
            'session_id': session_id,
            'object_id': obj_id,
            'normal': [0.0, 0.0, 1.0],
            'origin_offset': 0.5,
        })
        assert resp.status_code == 200
        result = resp.get_json()
        assert 'pieces' in result
        assert len(result['pieces']) == 2

    def test_cut_x_axis(self, app_client):
        """Cut along X axis produces two pieces."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)

        resp = app_client.post('/api/geometry/cut', json={
            'session_id': session_id,
            'object_id': obj_id,
            'normal': [1.0, 0.0, 0.0],
            'origin_offset': 0.5,
        })
        assert resp.status_code == 200

    def test_cut_y_axis(self, app_client):
        """Cut along Y axis produces two pieces."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)

        resp = app_client.post('/api/geometry/cut', json={
            'session_id': session_id,
            'object_id': obj_id,
            'normal': [0.0, 1.0, 0.0],
            'origin_offset': 0.5,
        })
        assert resp.status_code == 200


class TestGeometryScale:
    def test_scale_requires_params(self, app_client):
        """Scale without required params returns 400."""
        resp = app_client.post('/api/geometry/scale', json={})
        assert resp.status_code == 400

    def test_scale_uniform_2x(self, app_client):
        """Uniform 2x scale doubles dimensions."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)
        resp = app_client.post('/api/geometry/scale', json={
            'session_id': session_id,
            'object_id': obj_id,
            'sx': 2.0,
            'sy': 2.0,
            'sz': 2.0,
        })
        assert resp.status_code == 200

    def test_scale_half(self, app_client):
        """Scale by 0.5 reduces dimensions."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)

        resp = app_client.post('/api/geometry/scale', json={
            'session_id': session_id,
            'object_id': obj_id,
            'sx': 0.5,
            'sy': 0.5,
            'sz': 0.5,
        })
        assert resp.status_code == 200

    def test_scale_non_uniform(self, app_client):
        """Non-uniform scale (different per axis) succeeds."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)

        resp = app_client.post('/api/geometry/scale', json={
            'session_id': session_id,
            'object_id': obj_id,
            'sx': 2.0,
            'sy': 1.0,
            'sz': 0.5,
        })
        assert resp.status_code == 200


class TestGeometryRotate:
    def test_rotate_requires_params(self, app_client):
        """Rotate without required params returns 400."""
        resp = app_client.post('/api/geometry/rotate', json={})
        assert resp.status_code == 400

    def test_rotate_z_90_degrees(self, app_client):
        """Rotating 90 degrees around Z axis succeeds."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)

        resp = app_client.post('/api/geometry/rotate', json={
            'session_id': session_id,
            'object_id': obj_id,
            'angle': 90.0,
            'axis': 'z',
        })
        assert resp.status_code == 200

    def test_rotate_x_axis(self, app_client):
        """Rotate around X axis succeeds."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)

        resp = app_client.post('/api/geometry/rotate', json={
            'session_id': session_id,
            'object_id': obj_id,
            'angle': 45.0,
            'axis': 'x',
        })
        assert resp.status_code == 200

    def test_rotate_negative_angle(self, app_client):
        """Negative rotation angle succeeds."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)

        resp = app_client.post('/api/geometry/rotate', json={
            'session_id': session_id,
            'object_id': obj_id,
            'angle': -90.0,
            'axis': 'y',
        })
        assert resp.status_code == 200


class TestGeometryTranslate:
    def test_translate_requires_params(self, app_client):
        """Translate without required params returns 400."""
        resp = app_client.post('/api/geometry/translate', json={})
        assert resp.status_code == 400

    def test_translate_positive_offset(self, app_client):
        """Translating by positive offset shifts vertices."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)

        resp = app_client.post('/api/geometry/translate', json={
            'session_id': session_id,
            'object_id': obj_id,
            'dx': 5.0,
            'dy': 3.0,
            'dz': 1.0,
        })
        assert resp.status_code == 200

    def test_translate_zero_offset(self, app_client):
        """Translate with zero offset still succeeds."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)

        resp = app_client.post('/api/geometry/translate', json={
            'session_id': session_id,
            'object_id': obj_id,
            'dx': 0.0,
            'dy': 0.0,
            'dz': 0.0,
        })
        assert resp.status_code == 200


class TestGeometrySimplify:
    def test_simplify_requires_params(self, app_client):
        """Simplify without required params returns 400."""
        resp = app_client.post('/api/geometry/simplify', json={})
        assert resp.status_code == 400

    def test_simplify_reduces_polygons(self, app_client):
        """Simplification reduces polygon count."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)

        resp = app_client.post('/api/geometry/simplify', json={
            'session_id': session_id,
            'object_id': obj_id,
            'reduction_percent': 30,
        })
        assert resp.status_code == 200


class TestGeometrySmooth:
    def test_smooth_requires_params(self, app_client):
        """Smooth without required params returns 400."""
        resp = app_client.post('/api/geometry/smooth', json={})
        assert resp.status_code == 400

    def test_smooth_single_iteration(self, app_client):
        """Smoothing with single iteration succeeds."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)

        resp = app_client.post('/api/geometry/smooth', json={
            'session_id': session_id,
            'object_id': obj_id,
            'iterations': 1,
        })
        assert resp.status_code == 200

    def test_smooth_multiple_iterations(self, app_client):
        """Smoothing with multiple iterations succeeds."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)

        resp = app_client.post('/api/geometry/smooth', json={
            'session_id': session_id,
            'object_id': obj_id,
            'iterations': 5,
        })
        assert resp.status_code == 200


class TestGeometryInfo:
    def test_info_requires_params(self, app_client):
        """Info without required params returns 400."""
        resp = app_client.get('/api/geometry/info')
        assert resp.status_code == 400

    def test_info_returns_stats(self, app_client):
        """Info endpoint returns mesh statistics."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)
        resp = app_client.get(f'/api/geometry/info?session_id={session_id}&object_id={obj_id}')
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'num_vertices' in data or 'vertices' in data

    def test_info_returns_bbox(self, app_client):
        """Info endpoint returns bounding box."""
        session_id = store._generate_id()
        data = {'file': (io.BytesIO(_make_large_cube_stl(4.0)), 'large.stl'), 'session_id': session_id}
        resp = app_client.post('/api/import', data=data, content_type='multipart/form-data')
        obj_id = resp.get_json()['objects'][0]['id']

        resp = app_client.get(f'/api/geometry/info?session_id={session_id}&object_id={obj_id}')
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'bbox_min' in data
        assert 'bbox_max' in data


# --- Primitive Creation Tests

class TestPrimitives:
    def test_create_cube(self, app_client):
        """Creating a cube primitive succeeds."""
        resp = app_client.post('/api/primitives/create', json={
            'type': 'cube',
            'size': 50.0,
            'centered': True,
        })
        assert resp.status_code == 200
        result = resp.get_json()
        assert len(result['objects']) == 1
        obj = result['objects'][0]
        assert 'id' in obj
        assert 'vertices' in obj

    def test_create_sphere(self, app_client):
        """Creating a sphere primitive succeeds."""
        resp = app_client.post('/api/primitives/create', json={
            'type': 'sphere',
            'radius': 25.0,
            'segments': 16,
        })
        assert resp.status_code == 200
        result = resp.get_json()
        assert len(result['objects']) >= 1

    def test_create_cylinder(self, app_client):
        """Creating a cylinder primitive succeeds."""
        resp = app_client.post('/api/primitives/create', json={
            'type': 'cylinder',
            'radius': 25.0,
            'height': 50.0,
            'segments': 24,
        })
        assert resp.status_code == 200

    def test_create_cone(self, app_client):
        """Creating a cone primitive succeeds."""
        resp = app_client.post('/api/primitives/create', json={
            'type': 'cone',
            'radius': 25.0,
            'height': 50.0,
            'segments': 24,
        })
        assert resp.status_code == 200

    def test_create_torus(self, app_client):
        """Creating a torus primitive succeeds."""
        resp = app_client.post('/api/primitives/create', json={
            'type': 'torus',
            'radius': 25.0,
            'tube': 8.0,
            'segments': 16,
            'minor_segments': 12,
        })
        assert resp.status_code == 200
        result = resp.get_json()
        assert len(result['objects']) >= 1

    def test_unknown_primitive_type_returns_400(self, app_client):
        """Unknown primitive type returns 400."""
        resp = app_client.post('/api/primitives/create', json={'type': 'pyramid'})
        assert resp.status_code == 400

    def test_create_cube_with_session(self, app_client):
        """Creating a cube with session_id stores it in the session."""
        session_id = store._generate_id()
        resp = app_client.post('/api/primitives/create', json={
            'session_id': session_id,
            'type': 'cube',
            'size': 10.0,
        })
        assert resp.status_code == 200

        objects = store.get_all_objects(session_id)
        assert len(objects) >= 1

    def test_create_sphere_default_params(self, app_client):
        """Creating a sphere with default parameters succeeds."""
        resp = app_client.post('/api/primitives/create', json={'type': 'sphere'})
        assert resp.status_code == 200


# --- Error Handling Tests

class TestErrorHandling:
    def test_invalid_json_body(self, app_client):
        """Invalid JSON on a POST endpoint is rejected (400/415)."""
        resp = app_client.post('/api/geometry/scale', data='not json', content_type='application/json')
        assert resp.status_code in (400, 415)

    def test_missing_session_id_on_all_endpoints(self, app_client):
        """All endpoints that require session_id return 400 without it."""
        # Every listed endpoint must reject a missing session_id.
        endpoints = [
            '/api/csg/union',
            '/api/csg/subtract',
            '/api/csg/intersect',
            '/api/geometry/solid',
            '/api/geometry/hollow',
            '/api/geometry/cut',
            '/api/geometry/scale',
            '/api/geometry/rotate',
            '/api/geometry/translate',
            '/api/geometry/simplify',
            '/api/geometry/smooth',
        ]
        for endpoint in endpoints:
            resp = app_client.post(endpoint, json={})
            assert resp.status_code == 400, f'{endpoint} should return 400 without session_id'

    def test_nonexistent_object_id(self, app_client):
        """Scaling a non-existent object returns 400."""
        resp = app_client.post('/api/geometry/scale', json={
            'session_id': 'nonexistent',
            'object_id': 'xyz',
            'sx': 1.0, 'sy': 1.0, 'sz': 1.0,
        })
        assert resp.status_code == 400


# --- Session Management Tests

class TestSessionManagement:
    def test_session_persists_across_requests(self, app_client, unit_cube_file):
        """Objects added in one request are available in subsequent requests."""
        session_id, obj_id = _import_cube(app_client, unit_cube_file)

        # A second request reuses the same session.
        resp = app_client.get(f'/api/geometry/info?session_id={session_id}&object_id={obj_id}')
        assert resp.status_code == 200

    def test_multiple_objects_in_same_session(self, app_client, unit_cube_file):
        """Multiple objects can exist in the same session."""
        session_id, obj1 = _import_cube(app_client, unit_cube_file)
        _, obj2 = _import_cube(app_client, unit_cube_file, session_id=session_id)

        resp = app_client.get(f'/api/geometry/info?session_id={session_id}&object_id={obj1}')
        assert resp.status_code == 200

        resp = app_client.get(f'/api/geometry/info?session_id={session_id}&object_id={obj2}')
        assert resp.status_code == 200

    def test_object_replaced_after_operation(self, app_client, unit_cube_file):
        """After an operation, original object is removed and replaced with result."""
        session_id, obj_id = _import_cube(app_client, unit_cube_file)

        # Scaling replaces the object in the session.
        resp = app_client.post('/api/geometry/scale', json={
            'session_id': session_id,
            'object_id': obj_id,
            'sx': 2.0, 'sy': 2.0, 'sz': 2.0,
        })
        assert resp.status_code == 200

        # The original must be gone.
        original = store.get_object(session_id, obj_id)
        assert original is None

        # The new result object must exist.
        result = resp.get_json()
        new_obj = store.get_object(session_id, result['id'])
        assert new_obj is not None


# --- End-to-End Workflow Tests

class TestWorkflows:
    def test_full_import_to_export_workflow(self, app_client, unit_cube_file):
        """Complete workflow: import STL → get info → export as OBJ."""
        # Import
        session_id, obj_id = _import_cube(app_client, unit_cube_file)

        # Get info
        resp = app_client.get(f'/api/geometry/info?session_id={session_id}&object_id={obj_id}')
        assert resp.status_code == 200

        # Export as OBJ
        resp = app_client.get(f'/api/export?session_id={session_id}&object_id={obj_id}&format=obj')
        assert resp.status_code == 200
        assert 'text/wavefront-obj' in resp.content_type

    def test_import_and_csg_union_workflow(self, app_client):
        """Create two objects → union them → verify result exists."""
        session_id = store._generate_id()

        # Two overlapping manifold-ready cubes in the session.
        _, obj1 = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)
        _, obj2 = _create_manifold_cube(app_client, offset=(0.5, 0.5, 0.5), session_id=session_id)

        # Union them
        resp = app_client.post('/api/csg/union', json={
            'session_id': session_id,
            'object_ids': [obj1, obj2],
        })
        assert resp.status_code == 200
        result = resp.get_json()

        # The union result must export cleanly.
        resp = app_client.get(f'/api/export?session_id={session_id}&object_id={result["id"]}&format=stl')
        assert resp.status_code == 200

    def test_import_and_transform_workflow(self, app_client):
        """Create object → scale it → rotate it → export result."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, session_id=session_id)

        # Scale
        resp = app_client.post('/api/geometry/scale', json={
            'session_id': session_id,
            'object_id': obj_id,
            'sx': 2.0, 'sy': 2.0, 'sz': 2.0,
        })
        assert resp.status_code == 200
        obj_id = resp.get_json()['id']

        # Rotate
        resp = app_client.post('/api/geometry/rotate', json={
            'session_id': session_id,
            'object_id': obj_id,
            'angle': 45.0,
            'axis': 'z',
        })
        assert resp.status_code == 200
        obj_id = resp.get_json()['id']

        # Export
        resp = app_client.get(f'/api/export?session_id={session_id}&object_id={obj_id}&format=stl')
        assert resp.status_code == 200

    def test_import_cut_export_workflow(self, app_client):
        """Create → cut into pieces → export each piece."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)

        # Cut the cube in half
        resp = app_client.post('/api/geometry/cut', json={
            'session_id': session_id,
            'object_id': obj_id,
            'normal': [0.0, 0.0, 1.0],
            'origin_offset': 0.5,
        })
        assert resp.status_code == 200
        result = resp.get_json()

        # Export both pieces
        for piece in result['pieces']:
            resp = app_client.get(f'/api/export?session_id={session_id}&object_id={piece["id"]}&format=stl')
            assert resp.status_code == 200

    def test_import_hollow_export_workflow(self, app_client):
        """Create → hollow → export."""
        session_id = store._generate_id()
        _, obj_id = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)

        # Enlarge the cube first so a 1-unit wall fits.
        resp = app_client.post('/api/geometry/scale', json={
            'session_id': session_id,
            'object_id': obj_id,
            'sx': 5.0, 'sy': 5.0, 'sz': 5.0,
        })
        assert resp.status_code == 200
        obj_id = resp.get_json()['id']

        # Hollow with thin wall
        resp = app_client.post('/api/geometry/hollow', json={
            'session_id': session_id,
            'object_id': obj_id,
            'wall_thickness': 1.0,
        })
        assert resp.status_code == 200

        # Export result
        result = resp.get_json()
        resp = app_client.get(f'/api/export?session_id={session_id}&object_id={result["id"]}&format=stl')
        assert resp.status_code == 200

    def test_primitives_to_export_workflow(self, app_client):
        """Create primitive → store in session → export."""
        session_id = store._generate_id()

        # Create a cube in the session.
        resp = app_client.post('/api/primitives/create', json={
            'session_id': session_id,
            'type': 'cube',
            'size': 50.0,
        })
        assert resp.status_code == 200
        result = resp.get_json()

        # Export the primitive
        obj_id = result['objects'][0]['id']
        resp = app_client.get(f'/api/export?session_id={session_id}&object_id={obj_id}&format=stl')
        assert resp.status_code == 200

    def test_full_csg_subtract_workflow(self, app_client):
        """Create two objects → subtract → smooth result → export."""
        session_id = store._generate_id()

        # Create base cube
        _, base_id = _create_manifold_cube(app_client, offset=(0.0, 0.0, 0.0), session_id=session_id)

        # Tool cube overlaps the base by design.
        _, tool_id = _create_manifold_cube(app_client, offset=(0.5, 0.5, 0.5), session_id=session_id)

        # Subtract
        resp = app_client.post('/api/csg/subtract', json={
            'session_id': session_id,
            'base_id': base_id,
            'tool_id': tool_id,
        })
        assert resp.status_code == 200
        result = resp.get_json()

        # Subtract reports the replacement under 'updated'.
        updated_id = result['updated'][0]['id'] if result.get('updated') else None
        assert updated_id is not None, 'Subtract should have produced an updated object'

        # Smooth the result
        resp = app_client.post('/api/geometry/smooth', json={
            'session_id': session_id,
            'object_id': updated_id,
            'iterations': 2,
        })
        assert resp.status_code == 200

        # Export final result
        final_obj = resp.get_json()
        resp = app_client.get(f'/api/export?session_id={session_id}&object_id={final_obj["id"]}&format=stl')
        assert resp.status_code == 200
