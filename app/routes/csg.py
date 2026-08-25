"""Boolean (CSG) operations on session meshes via the manifold engine.

Union, subtract, and intersect endpoints load the selected objects from the
session store, validate their geometry, run the operation, and replace the
inputs with the resulting mesh.
"""
# ColliBoy

import uuid
import numpy as np
from flask import Blueprint, request, jsonify
from app.engine.manifold_wrapper import (
    union as _manifold_union,
    subtract as _manifold_subtract,
    intersect as _manifold_intersect,
    get_bounding_box,
    ManifoldError,
)
from app.models.session import store

bp = Blueprint('csg', __name__)


def _get_meshes_from_session(session_id: str, obj_ids) -> list:
    """Load (vertices, tri_indices) pairs for a list of session object ids."""
    missing = [oid for oid in obj_ids if store.get_object(session_id, oid) is None]
    if missing:
        raise ValueError(f'Object {missing[0]} not found')

    meshes = []
    for oid in obj_ids:
        obj = store.get_object(session_id, oid)
        vertices = np.array(obj['vertices'], dtype=np.float32).reshape(-1, 3)

        # Non-finite coordinates would poison the manifold kernel, so reject them up front
        if np.any(np.isnan(vertices)) or np.any(np.isinf(vertices)):
            raise ManifoldError(
                f'Object {oid} has invalid geometry (NaN/Inf vertices). '
                'Import a valid mesh.'
            )

        if obj.get('indices'):
            temp_indices = np.array(obj['indices'], dtype=np.uint32).reshape(-1, 3)
        else:
            num_faces = len(vertices) // 3
            if num_faces > 0:
                temp_indices = np.arange(num_faces * 3, dtype=np.uint32).reshape(-1, 3)
                vertices, temp_indices = _merge_vertices(vertices, temp_indices)
            else:
                temp_indices = np.array([], dtype=np.uint32).reshape(0, 3)

        meshes.append((vertices, temp_indices))
    return meshes


def _merge_vertices(vertices, tri_indices):
    rounded = np.round(vertices, decimals=6)
    unique_verts, inverse = np.unique(rounded, axis=0, return_inverse=True)
    merged_indices = inverse[tri_indices].astype(np.uint32)

    # Triangles whose corners collapsed onto one vertex are degenerate and get dropped
    valid = np.any(
        np.diff(merged_indices, axis=1) != 0,
        axis=1,
    )
    if not np.all(valid):
        merged_indices = merged_indices[valid]

    return unique_verts, merged_indices


def _bbox_overlap(verts_a: np.ndarray, verts_b: np.ndarray, epsilon: float = 1e-4) -> bool:
    min_a, max_a, _ = get_bounding_box(verts_a)
    min_b, max_b, _ = get_bounding_box(verts_b)
    return bool(np.all(max_a >= min_b - epsilon) and np.all(max_b >= min_a - epsilon))


@bp.route('/union', methods=['POST'])
def csg_union():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_ids = data.get('object_ids', [])

    if not session_id:
        return jsonify({'error': 'session_id required'}), 400
    if len(obj_ids) < 2:
        return jsonify({'error': 'At least 2 object_ids required for union'}), 400

    # Verify every object exists and its geometry is sound before touching the session
    try:
        meshes = _get_meshes_from_session(session_id, obj_ids)
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except ManifoldError as e:
        return jsonify({'error': f'Mesh validation failed: {str(e)}'}), 400

    # Record an undo snapshot of the inputs before they are replaced
    store.push_undo_snapshot(session_id, obj_ids, 'union')

    try:
        result_verts, result_tris = _manifold_union(meshes)
    except ManifoldError as e:
        return jsonify({
            'error': f'Union failed (manifold error): {str(e)}'
        }), 400
    except Exception as e:
        return jsonify({'error': f'Union failed: {str(e)}'}), 500

    new_obj_id = str(uuid.uuid4())[:8]
    verts_flat = result_verts.flatten().tolist()
    tris_flat = None if result_tris is None else result_tris.flatten().tolist()

    store.add_object(session_id, {
        'id': new_obj_id,
        'name': 'union_result',
        'format': 'mesh',
        'vertices': verts_flat,
        'indices': tris_flat,
        'normals': None,
        'num_vertices': int(len(result_verts)),
        'num_faces': len(result_tris) if result_tris is not None else 0,
    })

    for oid in obj_ids:
        store.remove_object(session_id, oid)

    store.commit_snapshot(session_id)

    return jsonify({
        'id': new_obj_id,
        'name': 'union_result',
        'vertices': verts_flat,
        'indices': tris_flat,
        'num_vertices': int(len(result_verts)),
        'num_faces': len(result_tris) if result_tris is not None else 0,
        'previous_object_ids': obj_ids,
    })


@bp.route('/subtract', methods=['POST'])
def csg_subtract():
    data = request.json or {}
    session_id = data.get('session_id')

    # Accept both plural (target_ids/tool_ids) and singular (base_id/tool_id) request shapes
    if 'target_ids' in data:
        target_ids = data['target_ids']
    elif 'base_id' in data:
        target_ids = [data['base_id']] if data['base_id'] else []
    else:
        target_ids = []

    if 'tool_ids' in data:
        tool_ids = data['tool_ids']
    elif 'tool_id' in data:
        tool_ids = [data['tool_id']] if data['tool_id'] else []
    else:
        tool_ids = []

    if not session_id:
        return jsonify({'error': 'session_id required'}), 400
    if len(tool_ids) < 1 or (len(tool_ids) == 1 and not tool_ids[0]):
        return jsonify({'error': 'At least 1 object_id required as the cutting tool for subtract'}), 400
    if not target_ids or (len(target_ids) == 1 and not target_ids[0]):
        return jsonify({'error': 'target_ids required - objects to subtract from'}), 400

    try:
        tool_meshes = _get_meshes_from_session(session_id, tool_ids)
        target_meshes = _get_meshes_from_session(session_id, target_ids)
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except ManifoldError as e:
        return jsonify({'error': f'Subtract failed (manifold error): {str(e)}'}), 400

    all_affected = list(set(tool_ids) | set(target_ids))
    store.push_undo_snapshot(session_id, all_affected, 'subtract')

    updated = []
    unaffected_ids = []

    try:
        for target_idx in range(len(target_ids)):
            target_obj = store.get_object(session_id, target_ids[target_idx])
            current_verts, indices = target_meshes[target_idx]

            changed = False

            for tool_verts, tool_tris in tool_meshes:
                if not _bbox_overlap(current_verts, tool_verts):
                    continue

                try:
                    new_verts, new_tris = _manifold_subtract((current_verts, indices), (tool_verts, tool_tris))
                except ManifoldError as e:
                    continue

                current_verts, indices = new_verts, new_tris
                changed = True

            if not changed:
                unaffected_ids.append(target_ids[target_idx])
                continue

            new_obj_id = str(uuid.uuid4())[:8]
            verts_flat = current_verts.flatten().tolist()
            tris_flat = None if indices is None else indices.flatten().tolist()

            store.add_object(session_id, {
                'id': new_obj_id,
                'name': (target_obj or {}).get('name', 'object'),
                'format': 'mesh',
                'vertices': verts_flat,
                'indices': tris_flat,
                'normals': None,
                'num_vertices': len(current_verts),
                'num_faces': len(indices) if indices is not None else 0,
            })

            store.remove_object(session_id, target_ids[target_idx])

            updated.append({
                'previous_id': target_ids[target_idx],
                'id': new_obj_id,
                'name': (target_obj or {}).get('name', 'object'),
                'vertices': verts_flat,
                'indices': tris_flat,
                'num_vertices': len(current_verts),
                'num_faces': len(indices) if indices is not None else 0,
            })

    except Exception as e:
        return jsonify({'error': f'Subtract failed: {str(e)}'}), 500

    store.commit_snapshot(session_id)

    return jsonify({
        'updated': updated,
        'unaffected_target_ids': unaffected_ids,
        'removed_tool_ids': [],
    })


@bp.route('/intersect', methods=['POST'])
def csg_intersect():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_ids = data.get('object_ids', [])

    if not session_id:
        return jsonify({'error': 'session_id required'}), 400
    if len(obj_ids) < 2:
        return jsonify({'error': 'At least 2 object_ids required for intersect'}), 400

    store.push_undo_snapshot(session_id, obj_ids, 'intersect')

    try:
        meshes = _get_meshes_from_session(session_id, obj_ids)
        result_verts, result_tris = _manifold_intersect(meshes)
    except ManifoldError as e:
        return jsonify({'error': f'Intersect failed (manifold error): {str(e)}'}), 400

    new_obj_id = str(uuid.uuid4())[:8]
    verts_flat = result_verts.flatten().tolist()
    tris_flat = None if result_tris is None else result_tris.flatten().tolist()

    store.add_object(session_id, {
        'id': new_obj_id,
        'name': 'intersect_result',
        'format': 'mesh',
        'vertices': verts_flat,
        'indices': tris_flat,
        'normals': None,
        'num_vertices': int(len(result_verts)),
        'num_faces': len(result_tris) if result_tris is not None else 0,
    })

    # ColliBoy
    for oid in obj_ids:
        store.remove_object(session_id, oid)

    store.commit_snapshot(session_id)

    return jsonify({
        'id': new_obj_id,
        'name': 'intersect_result',
        'vertices': verts_flat,
        'indices': tris_flat,
        'num_vertices': int(len(result_verts)),
        'num_faces': len(result_tris) if result_tris is not None else 0,
        'previous_object_ids': obj_ids,
    })
