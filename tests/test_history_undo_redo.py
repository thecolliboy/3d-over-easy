"""Regression tests for undo/redo restoring exact session state.

Operations replace objects with brand-new ids (scale, union, etc.), so undo must
bring back every object that existed before the operation - and drop everything
the operation created or removed - while redo re-applies the operation itself.
These tests pin down both directions against a multi-object session where an
unrelated "bystander" model must survive untouched.
"""
# ColliBoy

import uuid

import numpy as np
import pytest

from app import create_app
from app.models.session import store


@pytest.fixture
def app_client():
    """Provide a Flask test client."""
    app = create_app('default')
    with app.test_client() as client:
        yield client


# ── Helpers ───────────────────────────────────────────────────────────────

def _make_cube(offset=(0.0, 0.0, 0.0)):
    """Build a manifold-ready cube mesh (vertices + indices) at the given offset."""
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

    return {
        'vertices': v.flatten().tolist(),
        'indices': t.flatten().tolist(),
    }


def _add_cube(session_id, offset=(0.0, 0.0, 0.0)):
    """Insert a cube into the session and return its id."""
    mesh = _make_cube(offset)
    obj_id = str(uuid.uuid4())[:8]
    store.add_object(session_id, {
        'id': obj_id,
        'name': f'cube_{offset}',
        'format': 'mesh',
        **mesh,
        'normals': None,
        'num_vertices': 8,
        'num_faces': 12,
    })
    return obj_id


def _session_object_ids(session_id):
    """Return the set of object ids currently held in the session."""
    return {obj['id'] for obj in store.get_all_objects(session_id)}


# ── Undo tests ───────────────────────────────────────────────────────────

class TestUndo:
    def test_undo_restores_full_session_state(self, app_client):
        """Undoing a scale brings back every pre-op object, including unrelated ones."""
        session_id = str(uuid.uuid4())
        cube_a = _add_cube(session_id, (0.0, 0.0, 0.0))
        cube_b = _add_cube(session_id, (2.0, 0.0, 0.0))
        bystander = _add_cube(session_id, (4.0, 0.0, 0.0))
        pre_ids = {cube_a, cube_b, bystander}

        resp = app_client.post('/api/geometry/scale', json={
            'session_id': session_id,
            'object_id': cube_a,
            'sx': 2.0, 'sy': 2.0, 'sz': 2.0,
        })
        assert resp.status_code == 200
        scaled = resp.get_json()
        # The operation replaces the object with a brand-new id
        assert scaled['id'] != cube_a
        assert _session_object_ids(session_id) == {scaled['id'], cube_b, bystander}

        resp = app_client.post('/api/history/undo', json={'session_id': session_id})
        assert resp.status_code == 200
        result = resp.get_json()

        # The response must carry the complete restored session - not just the
        # affected object - otherwise unrelated models vanish from the viewport.
        returned_ids = {obj['id'] for obj in result['objects']}
        assert returned_ids == pre_ids
        assert _session_object_ids(session_id) == pre_ids

    def test_undo_union_restores_inputs_and_drops_result(self, app_client):
        """Undoing a union restores both inputs and removes the union result."""
        session_id = str(uuid.uuid4())
        cube_a = _add_cube(session_id, (0.0, 0.0, 0.0))
        cube_b = _add_cube(session_id, (2.0, 0.0, 0.0))
        bystander = _add_cube(session_id, (4.0, 0.0, 0.0))
        pre_ids = {cube_a, cube_b, bystander}

        resp = app_client.post('/api/csg/union', json={
            'session_id': session_id,
            'object_ids': [cube_a, cube_b],
        })
        assert resp.status_code == 200
        union_result = resp.get_json()
        assert _session_object_ids(session_id) == {union_result['id'], bystander}

        resp = app_client.post('/api/history/undo', json={'session_id': session_id})
        assert resp.status_code == 200
        result = resp.get_json()

        returned_ids = {obj['id'] for obj in result['objects']}
        # Inputs are back under their original ids; the union result is gone.
        assert returned_ids == pre_ids
        assert _session_object_ids(session_id) == pre_ids

    def test_multiple_undos_walk_back_to_original_state(self, app_client):
        """Two consecutive operations can be undone in order to reach the start."""
        session_id = str(uuid.uuid4())
        cube_a = _add_cube(session_id, (0.0, 0.0, 0.0))
        cube_b = _add_cube(session_id, (2.0, 0.0, 0.0))
        pre_ids = {cube_a, cube_b}

        resp = app_client.post('/api/geometry/scale', json={
            'session_id': session_id, 'object_id': cube_a,
            'sx': 2.0, 'sy': 2.0, 'sz': 2.0,
        })
        assert resp.status_code == 200
        scaled_a = resp.get_json()['id']

        resp = app_client.post('/api/geometry/scale', json={
            'session_id': session_id, 'object_id': cube_b,
            'sx': 3.0, 'sy': 3.0, 'sz': 3.0,
        })
        assert resp.status_code == 200
        scaled_b = resp.get_json()['id']

        # After both scales the session holds two replaced objects; each undo
        # walks back one step: first to {scaled_a, cube_b}, then to the start.
        for expected in ({scaled_a, cube_b}, pre_ids):
            resp = app_client.post('/api/history/undo', json={'session_id': session_id})
            assert resp.status_code == 200
            returned_ids = {obj['id'] for obj in resp.get_json()['objects']}
            assert _session_object_ids(session_id) == expected
            assert returned_ids == expected

    def test_undo_without_history_returns_409(self, app_client):
        """Undoing with an empty history reports nothing to undo."""
        session_id = str(uuid.uuid4())
        _add_cube(session_id)

        resp = app_client.post('/api/history/undo', json={'session_id': session_id})
        assert resp.status_code == 409


# ── Split (cut) flow tests ───────────────────────────────────────────────

class TestCutPreview:
    def test_preview_cut_does_not_mutate_session_or_history(self, app_client):
        """A preview cut returns pieces without touching the session or undo stack."""
        session_id = str(uuid.uuid4())
        cube_a = _add_cube(session_id, (0.0, 0.0, 0.0))

        resp = app_client.post('/api/geometry/cut', json={
            'session_id': session_id,
            'object_id': cube_a,
            'normal': [0.0, 1.0, 0.0],
            'origin_offset': 0.5,
            'preview': True,
        })
        assert resp.status_code == 200
        result = resp.get_json()
        assert len(result['pieces']) == 2

        # The object is untouched and no history entry was created - previews fire
        # on every plane drag while in split mode, so any mutation here would leak
        # throwaway objects that undo resurrects.
        assert _session_object_ids(session_id) == {cube_a}
        info = store.get_history_info(session_id)
        assert info['undo_count'] == 0 and info['redo_count'] == 0

    def test_split_flow_undo_restores_original_without_extras(self, app_client):
        """Preview + real cut (the split flow) undoes back to exactly the pre-split state."""
        session_id = str(uuid.uuid4())
        cube_a = _add_cube(session_id, (0.0, 0.0, 0.0))
        bystander = _add_cube(session_id, (4.0, 0.0, 0.0))

        # Live previews while the plane is dragged - must not mutate anything
        for offset in (0.25, 0.5):
            resp = app_client.post('/api/geometry/cut', json={
                'session_id': session_id,
                'object_id': cube_a,
                'normal': [0.0, 1.0, 0.0],
                'origin_offset': offset,
                'preview': True,
            })
            assert resp.status_code == 200
        assert _session_object_ids(session_id) == {cube_a, bystander}

        # The authoritative cut (what confirm issues) consumes the original
        resp = app_client.post('/api/geometry/cut', json={
            'session_id': session_id,
            'object_id': cube_a,
            'normal': [0.0, 1.0, 0.0],
            'origin_offset': 0.5,
        })
        assert resp.status_code == 200
        piece_ids = {p['id'] for p in resp.get_json()['pieces']}
        assert _session_object_ids(session_id) == {bystander} | piece_ids

        # Undo must restore exactly the pre-split state - no stray duplicates
        resp = app_client.post('/api/history/undo', json={'session_id': session_id})
        assert resp.status_code == 200
        returned_ids = {obj['id'] for obj in resp.get_json()['objects']}
        assert _session_object_ids(session_id) == {cube_a, bystander}
        assert returned_ids == {cube_a, bystander}

        # And redo re-applies the split
        resp = app_client.post('/api/history/redo', json={'session_id': session_id})
        assert resp.status_code == 200
        assert _session_object_ids(session_id) == {bystander} | piece_ids


# ── Redo tests ───────────────────────────────────────────────────────────

class TestRedo:
    def test_redo_reapplies_operation(self, app_client):
        """After undoing a union, redo brings the result back and drops the inputs."""
        session_id = str(uuid.uuid4())
        cube_a = _add_cube(session_id, (0.0, 0.0, 0.0))
        cube_b = _add_cube(session_id, (2.0, 0.0, 0.0))
        bystander = _add_cube(session_id, (4.0, 0.0, 0.0))

        resp = app_client.post('/api/csg/union', json={
            'session_id': session_id,
            'object_ids': [cube_a, cube_b],
        })
        assert resp.status_code == 200
        union_result = resp.get_json()
        post_ids = {union_result['id'], bystander}

        app_client.post('/api/history/undo', json={'session_id': session_id})
        assert _session_object_ids(session_id) == {cube_a, cube_b, bystander}

        resp = app_client.post('/api/history/redo', json={'session_id': session_id})
        assert resp.status_code == 200
        result = resp.get_json()

        # Redo must restore the post-op state: union result present, inputs gone.
        returned_ids = {obj['id'] for obj in result['objects']}
        assert returned_ids == post_ids
        assert _session_object_ids(session_id) == post_ids

    def test_redo_without_history_returns_409(self, app_client):
        """Redoing with an empty redo stack reports nothing to redo."""
        session_id = str(uuid.uuid4())
        _add_cube(session_id)

        resp = app_client.post('/api/history/redo', json={'session_id': session_id})
        assert resp.status_code == 409

    def test_new_operation_clears_redo_stack(self, app_client):
        """Branching after an undo truncates the redo history (standard behavior)."""
        session_id = str(uuid.uuid4())
        cube_a = _add_cube(session_id, (0.0, 0.0, 0.0))
        cube_b = _add_cube(session_id, (2.0, 0.0, 0.0))

        resp = app_client.post('/api/geometry/scale', json={
            'session_id': session_id, 'object_id': cube_a,
            'sx': 2.0, 'sy': 2.0, 'sz': 2.0,
        })
        assert resp.status_code == 200

        app_client.post('/api/history/undo', json={'session_id': session_id})

        # A new operation after the undo must clear the redo stack
        resp = app_client.post('/api/geometry/scale', json={
            'session_id': session_id, 'object_id': cube_b,
            'sx': 2.0, 'sy': 2.0, 'sz': 2.0,
        })
        assert resp.status_code == 200

        info = store.get_history_info(session_id)
        assert info['can_redo'] is False
        assert info['redo_count'] == 0
