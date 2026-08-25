"""Single-object mesh operations: repair, hollow, cut, transform, and analysis.

Each endpoint loads one session object, runs the corresponding manifold engine
operation (or a pure computation), and stores the result back into the session.
Long-running operations are wrapped in timeout_operation so oversized meshes
fail fast with a 504 instead of hanging the request.
"""
# ColliBoy

import uuid
import numpy as np
from flask import Blueprint, request, jsonify
from app.engine.manifold_wrapper import (
    repair as _repair,
    hollow as _hollow,
    cut_by_plane as _cut_by_plane,
    scale_mesh as _scale_mesh,
    rotate_mesh as _rotate_mesh,
    translate_mesh as _translate_mesh,
    transform_mesh as _transform_mesh,
    simplify_mesh as _simplify_mesh,
    smooth_mesh as _smooth_mesh,
    fillet_mesh as _fillet_mesh,
    chamfer_mesh as _chamfer_mesh,
    detect_overhangs as _detect_overhangs,
    compute_thickness_map as _compute_thickness_map,
    compute_lod_levels as _compute_lod_levels,
    get_bounding_box,
    get_mesh_stats as _get_mesh_stats,
)
from app.models.session import store
from app.utils.timeout import timeout_operation, MeshProcessingTimeout

bp = Blueprint('geometry', __name__)


def _push_undo(session_id, obj_ids, operation):
    """Snapshot the affected objects for undo before mutating them."""
    try:
        return store.push_undo_snapshot(session_id, obj_ids, operation)
    except Exception:
        pass
    return None


def _load_obj(session_id, obj_id):
    """Fetch a session object as indexed mesh data (vertices, tri_indices)."""
    obj = store.get_object(session_id, obj_id)
    if not obj:
        raise ValueError(f'Object {obj_id} not found')

    vertices = np.array(obj['vertices'], dtype=np.float32).reshape(-1, 3)

    indices = None
    if obj.get('indices'):
        indices = np.array(obj['indices'], dtype=np.uint32).reshape(-1, 3)
    else:
        # Unindexed meshes store flat corner runs - each group of three is one triangle.
        # Weld the duplicated corners (STL repeats shared vertices per face) so the
        # temporary indices addressing the flat list map into a deduped vertex pool.
        num_faces = len(vertices) // 3
        if num_faces > 0:
            temp_indices = np.arange(num_faces * 3, dtype=np.uint32).reshape(-1, 3)
            vertices, indices = _merge_vertices(vertices, temp_indices)

    return vertices, indices


def _merge_vertices(vertices, tri_indices):
    """Weld duplicate and near-duplicate vertex positions into an indexed mesh.

    STL payloads repeat shared corners per face; manifold operations need a
    single vertex pool, so positions are snapped to a 1e-6 grid and deduped.
    Returns (merged_vertices, merged_indices).
    """
    # Snap positions onto a fine grid to absorb floating point imprecision
    rounded = np.round(vertices, decimals=6)

    # Unique positions become the new vertex pool; inverse maps old slots to it
    unique_verts, inverse = np.unique(rounded, axis=0, return_inverse=True)

    # Remap triangle corners through that index translation
    merged_indices = inverse[tri_indices].astype(np.uint32)

    return unique_verts, merged_indices


def _piece_payload(result_verts, result_tris, name):
    """Build one piece's JSON payload (fresh id + geometry) without storing anything."""
    new_obj_id = str(uuid.uuid4())[:8]
    verts_flat = result_verts.flatten().tolist()

    tris_flat = None
    if result_tris is not None:
        # Flatten 2-D (T,3) index arrays to 1-D for JSON transport
        if len(np.array(result_tris).shape) > 1:
            tris_flat = result_tris.flatten().tolist()
        else:
            tris_flat = result_tris.tolist()

    return {
        'id': new_obj_id,
        'name': name,
        'vertices': verts_flat,
        'indices': tris_flat,
        'num_vertices': len(result_verts),
        'num_faces': len(result_tris) if result_tris is not None else 0,
    }


def _save_result(session_id, result_verts, result_tris, name='result', format_type='mesh'):
    """Store an operation result in the session and build its JSON payload."""
    payload = _piece_payload(result_verts, result_tris, name)

    store.add_object(session_id, {
        'id': payload['id'],
        'name': payload['name'],
        'format': format_type,
        'vertices': payload['vertices'],
        'indices': payload['indices'],
        'normals': None,
        'num_vertices': payload['num_vertices'],
        'num_faces': payload['num_faces'],
    })

    # Record the post-op state so redo can re-apply this operation (the old object
    # was removed above and replaced with a new id - only a full-state commit knows).
    store.commit_snapshot(session_id)

    return payload


@bp.route('/repair', methods=['POST'])
@timeout_operation(30)
def geometry_repair():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    _push_undo(session_id, [obj_id], 'repair')

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result_verts, result_tris = _repair(vertices, indices)
    except MeshProcessingTimeout as e:
        return jsonify({'error': str(e), 'timeout': True}), 504
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Repair failed: {str(e)}'}), 400

    store.remove_object(session_id, obj_id)
    return jsonify(_save_result(session_id, result_verts, result_tris, 'repaired', 'mesh'))


@bp.route('/hollow', methods=['POST'])
@timeout_operation(30)
def geometry_hollow():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    wall_thickness = float(data.get('wall_thickness', 2.0))

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    _push_undo(session_id, [obj_id], 'hollow')

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result_verts, result_tris = _hollow(vertices, indices, wall_thickness)
    except MeshProcessingTimeout as e:
        return jsonify({'error': str(e), 'timeout': True}), 504
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Hollow failed: {str(e)}'}), 400

    store.remove_object(session_id, obj_id)
    return jsonify(_save_result(session_id, result_verts, result_tris, 'hollowed', 'mesh'))


@bp.route('/cut', methods=['POST'])
@timeout_operation(30)
def geometry_cut():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    normal = data.get('normal', [0.0, 0.0, 1.0])
    origin_offset = float(data.get('origin_offset', 0.0))
    preview = bool(data.get('preview'))

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        pieces = _cut_by_plane(vertices, indices, tuple(normal), origin_offset)
    except MeshProcessingTimeout as e:
        return jsonify({'error': str(e), 'timeout': True}), 504
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Cut failed: {str(e)}'}), 400

    if preview:
        # Read-only cut for split mode's live preview - it must not mutate the
        # session or push history, otherwise every plane drag would leave
        # throwaway pieces behind that undo resurrects.
        return jsonify({'pieces': [
            _piece_payload(pv, pt, f'cut_piece_{i+1}') for i, (pv, pt) in enumerate(pieces)
        ]})

    _push_undo(session_id, [obj_id], 'cut')
    store.remove_object(session_id, obj_id)

    # ColliBoy
    results = []
    for i, (pv, pt) in enumerate(pieces):
        result = _save_result(session_id, pv, pt, f'cut_piece_{i+1}', 'mesh')
        results.append(result)

    return jsonify({'pieces': results})


@bp.route('/scale', methods=['POST'])
def geometry_scale():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    sx = float(data.get('sx', 1.0))
    sy = float(data.get('sy', 1.0))
    sz = float(data.get('sz', 1.0))

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    _push_undo(session_id, [obj_id], 'scale')

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result_verts, result_tris = _scale_mesh(vertices, indices, (sx, sy, sz))
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Scale failed: {str(e)}'}), 400

    store.remove_object(session_id, obj_id)
    return jsonify(_save_result(session_id, result_verts, result_tris, 'scaled', 'mesh'))


@bp.route('/rotate', methods=['POST'])
def geometry_rotate():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    angle = float(data.get('angle', 0.0))
    axis = data.get('axis', 'z')

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    _push_undo(session_id, [obj_id], 'rotate')

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result_verts, result_tris = _rotate_mesh(vertices, indices, angle, axis)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Rotate failed: {str(e)}'}), 400

    store.remove_object(session_id, obj_id)
    return jsonify(_save_result(session_id, result_verts, result_tris, 'rotated', 'mesh'))


@bp.route('/translate', methods=['POST'])
def geometry_translate():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    dx = float(data.get('dx', 0.0))
    dy = float(data.get('dy', 0.0))
    dz = float(data.get('dz', 0.0))

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    _push_undo(session_id, [obj_id], 'translate')

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result_verts, result_tris = _translate_mesh(vertices, indices, (dx, dy, dz))
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Translate failed: {str(e)}'}), 400

    store.remove_object(session_id, obj_id)
    return jsonify(_save_result(session_id, result_verts, result_tris, 'translated', 'mesh'))


@bp.route('/simplify', methods=['POST'])
@timeout_operation(30)
def geometry_simplify():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    reduction_percent = float(data.get('reduction_percent', 50))

    tolerance = reduction_percent * 0.01

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    _push_undo(session_id, [obj_id], 'simplify')

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result_verts, result_tris = _simplify_mesh(vertices, indices, tolerance)
    except MeshProcessingTimeout as e:
        return jsonify({'error': str(e), 'timeout': True}), 504
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Simplify failed: {str(e)}'}), 400

    store.remove_object(session_id, obj_id)
    return jsonify(_save_result(session_id, result_verts, result_tris, 'simplified', 'mesh'))


@bp.route('/simplify-preview', methods=['POST'])
@timeout_operation(10)
def geometry_simplify_preview():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    reduction_percent = float(data.get('reduction_percent', 50))

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        original_faces = len(indices) if indices is not None else len(vertices) // 3
        tolerance = reduction_percent * 0.01
        result_verts, result_tris = _simplify_mesh(vertices, indices, tolerance)
        preview_faces = len(result_tris) if result_tris is not None else 0

        return jsonify({
            'original_faces': original_faces,
            'preview_faces': preview_faces,
            'reduction_percent': reduction_percent,
            'estimated_ratio': round(preview_faces / max(original_faces, 1), 2),
        })
    except MeshProcessingTimeout as e:
        return jsonify({'error': str(e), 'timeout': True}), 504
    except Exception as e:
        return jsonify({'error': f'Preview failed: {str(e)}'}), 400


@bp.route('/smooth', methods=['POST'])
@timeout_operation(30)
def geometry_smooth():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    iterations = int(data.get('iterations', 1))

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    _push_undo(session_id, [obj_id], 'smooth')

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result_verts, result_tris = _smooth_mesh(vertices, indices, iterations)
    except MeshProcessingTimeout as e:
        return jsonify({'error': str(e), 'timeout': True}), 504
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Smooth failed: {str(e)}'}), 400

    store.remove_object(session_id, obj_id)
    return jsonify(_save_result(session_id, result_verts, result_tris, 'smoothed', 'mesh'))


@bp.route('/fillet', methods=['POST'])
@timeout_operation(30)
def geometry_fillet():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    radius = float(data.get('radius', 1.0))
    segments = int(data.get('segments', 3))

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    _push_undo(session_id, [obj_id], 'fillet')

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result_verts, result_tris = _fillet_mesh(vertices, indices, radius, segments)
    except MeshProcessingTimeout as e:
        return jsonify({'error': str(e), 'timeout': True}), 504
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Fillet failed: {str(e)}'}), 400

    store.remove_object(session_id, obj_id)
    return jsonify(_save_result(session_id, result_verts, result_tris, 'filleted', 'mesh'))


@bp.route('/chamfer', methods=['POST'])
@timeout_operation(30)
def geometry_chamfer():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    distance = float(data.get('distance', 1.0))
    segments = int(data.get('segments', 1))

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    _push_undo(session_id, [obj_id], 'chamfer')

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result_verts, result_tris = _chamfer_mesh(vertices, indices, distance, segments)
    except MeshProcessingTimeout as e:
        return jsonify({'error': str(e), 'timeout': True}), 504
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Chamfer failed: {str(e)}'}), 400

    store.remove_object(session_id, obj_id)
    return jsonify(_save_result(session_id, result_verts, result_tris, 'chamfered', 'mesh'))


@bp.route('/info', methods=['GET'])
def geometry_info():
    session_id = request.args.get('session_id')
    obj_id = request.args.get('object_id')

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        stats = _get_mesh_stats(vertices, indices)
        bbox_min, bbox_max, diagonal = get_bounding_box(vertices)

        return jsonify({
            **stats,
            'bbox_min': bbox_min.tolist(),
            'bbox_max': bbox_max.tolist(),
            'diagonal': round(diagonal, 4),
        })
    except Exception as e:
        return jsonify({'error': f'Info failed: {str(e)}'}), 400


@bp.route('/overhang', methods=['POST'])
@timeout_operation(30)
def geometry_overhang():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    build_direction = data.get('build_direction', [0.0, 1.0, 0.0])
    overhang_angle = float(data.get('overhang_angle', 45.0))

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result = _detect_overhangs(vertices, indices, tuple(build_direction), overhang_angle)

        return jsonify({
            'overhang_indices': result['overhang_indices'].tolist(),
            'overhang_colors': result['overhang_colors'].flatten().tolist(),
            'max_overhang_angle': result['max_overhang_angle'],
            'overhang_count': result['overhang_count'],
            'overhang_ratio': result['overhang_ratio'],
        })
    except MeshProcessingTimeout as e:
        return jsonify({'error': str(e), 'timeout': True}), 504
    except Exception as e:
        return jsonify({'error': f'Overhang detection failed: {str(e)}'}), 400


@bp.route('/thickness-map', methods=['POST'])
@timeout_operation(30)
def geometry_thickness_map():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    min_thickness = float(data.get('min_thickness', 0.1))
    max_thickness = float(data.get('max_thickness', 10.0))

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result = _compute_thickness_map(vertices, indices, min_thickness, max_thickness)

        return jsonify({
            'vertex_colors': result['vertex_colors'].flatten().tolist(),
            'face_colors': result['face_colors'].flatten().tolist(),
            'min_face_thickness': round(result['min_face_thickness'], 4),
            'max_face_thickness': round(result['max_face_thickness'], 4),
            'mean_face_thickness': round(result['mean_face_thickness'], 4),
        })
    except MeshProcessingTimeout as e:
        return jsonify({'error': str(e), 'timeout': True}), 504
    except Exception as e:
        return jsonify({'error': f'Thickness map failed: {str(e)}'}), 400


@bp.route('/lod', methods=['POST'])
@timeout_operation(30)
def geometry_lod():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    num_levels = int(data.get('num_levels', 3))

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result = _compute_lod_levels(vertices, indices, num_levels)

        return jsonify({
            'lod_levels': result['lod_levels'],
            'original_faces': result['original_faces'],
            'target_ratios': result['target_ratios'],
        })
    except MeshProcessingTimeout as e:
        return jsonify({'error': str(e), 'timeout': True}), 504
    except Exception as e:
        return jsonify({'error': f'LOD computation failed: {str(e)}'}), 400


@bp.route('/transform', methods=['POST'])
def geometry_transform():
    data = request.json or {}
    session_id = data.get('session_id')
    obj_id = data.get('object_id')
    matrix = data.get('matrix')

    if not session_id or not obj_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    _push_undo(session_id, [obj_id], 'transform')

    try:
        vertices, indices = _load_obj(session_id, obj_id)
        result_verts, result_tris = _transform_mesh(vertices, indices, matrix)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Transform failed: {str(e)}'}), 400

    store.remove_object(session_id, obj_id)
    return jsonify(_save_result(session_id, result_verts, result_tris, 'transformed', 'mesh'))
