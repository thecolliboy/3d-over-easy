"""Endpoints for generating parametric primitive meshes (cube, sphere, cylinder, cone, torus, egg)."""
# ColliBoy

import uuid
from flask import Blueprint, request, jsonify
from app.engine.manifold_wrapper import (
    create_cube,
    create_sphere,
    create_cylinder,
    create_cone,
    create_torus,
    create_egg,
)
from app.models.session import store

bp = Blueprint('primitives', __name__)


@bp.route('/create', methods=['POST'])
def create_primitive():
    data = request.json or {}
    session_id = data.get('session_id')
    ptype = data.get('type', 'cube').lower()

    try:
        if ptype == 'cube':
            size_val = data.get('size', [50.0, 50.0, 50.0])
            if isinstance(size_val, (int, float)):
                params = {'size': (float(size_val), float(size_val), float(size_val))}
            else:
                params = {'size': (float(size_val[0]), float(size_val[1]), float(size_val[2]))}
            if data.get('centered') is not None:
                params['centered'] = bool(data['centered'])
        elif ptype == 'sphere':
            params = {
                'radius': float(data.get('radius', 25.0)),
                'segments': int(data.get('segments', 16)),
            }
        elif ptype == 'cylinder':
            height_val = data.get('height')
            radius_val = data.get('radius')
            params = {
                'height': float(height_val[0]) if isinstance(height_val, list) else float(height_val),
                'radius_bottom': float(radius_val[0]) if isinstance(radius_val, list) else float(radius_val),
                'segments': int(data.get('segments', 24)),
            }
            if data.get('centered') is not None:
                params['centered'] = bool(data['centered'])
        elif ptype == 'cone':
            height_val = data.get('height')
            radius_val = data.get('radius')
            params = {
                'height': float(height_val[0]) if isinstance(height_val, list) else float(height_val),
                'radius': float(radius_val[0]) if isinstance(radius_val, list) else float(radius_val),
                'segments': int(data.get('segments', 24)),
            }
            if data.get('centered') is not None:
                params['centered'] = bool(data['centered'])
        elif ptype == 'torus':
            major_val = data.get('radius')
            minor_val = data.get('tube')
            params = {
                'major_radius': float(major_val[0]) if isinstance(major_val, list) else float(major_val),
                'minor_radius': float(minor_val[0]) if isinstance(minor_val, list) else float(minor_val),
                'major_segments': int(data.get('segments', 16)),
                'minor_segments': int(data.get('minor_segments', 12)),
            }
        elif ptype == 'egg':
            radius_val = data.get('radius', 25.0)
            height_val = data.get('height', 60.0)
            params = {
                'radius': float(radius_val[0]) if isinstance(radius_val, list) else float(radius_val),
                'height': float(height_val[0]) if isinstance(height_val, list) else float(height_val),
                'segments': int(data.get('segments', 24)),
            }
            if data.get('centered') is not None:
                params['centered'] = bool(data['centered'])
        else:
            return jsonify({'error': f'Unknown primitive type: {ptype}'}), 400

        creators = {
            'cube': create_cube,
            'sphere': create_sphere,
            'cylinder': create_cylinder,
            'cone': create_cone,
            'torus': create_torus,
            'egg': create_egg,
        }

        result_verts, result_tris = creators[ptype](**params)
    except Exception as e:
        return jsonify({'error': f'Failed to create {ptype}: {str(e)}'}), 400

    response = {
        'id': str(uuid.uuid4())[:8],
        'name': f'{ptype}_primitive',
        'format': 'mesh',
        'vertices': result_verts.flatten().tolist(),
        'indices': result_tris.flatten().tolist(),
        'num_vertices': len(result_verts),
        'num_faces': len(result_tris),
    }

    # File the mesh under the given session, or mint one when none arrives (ColliBoy)
    if session_id:
        store.add_object(session_id, response)
        returned_session_id = session_id
    else:
        session = store.get_or_create_session(None)
        store.add_object(session['id'], response)
        returned_session_id = session['id']

    result_obj = response.copy()
    result_obj['session_id'] = returned_session_id

    return jsonify({'objects': [result_obj], 'session_id': returned_session_id})