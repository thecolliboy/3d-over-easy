"""Object management endpoints for session meshes."""
# ColliBoy

import copy
import uuid
from flask import Blueprint, request, jsonify
from app.models.session import store

bp = Blueprint('objects', __name__)


@bp.route('/duplicate', methods=['POST'])
def duplicate_object():
    """Clone an object within its session; the frontend uses this for paste operations.

    Body: { session_id, object_id }. Response: the clone's full mesh data and id, in
    the same shape returned by the csg/primitives/geometry routes.
    """
    data = request.json or {}
    session_id = data.get('session_id')
    object_id = data.get('object_id')

    if not session_id or not object_id:
        return jsonify({'error': 'session_id and object_id required'}), 400

    src = store.get_object(session_id, object_id)
    if not src:
        return jsonify({'error': f'Object {object_id} not found'}), 404

    # get_object() returns the live dict, not a copy; deepcopy first so the clone
    # does not alias or mutate the source's vertex/index/normal/color lists.
    new_obj = copy.deepcopy(src)

    # add_object() mints an id only if the dict has none; the deepcopy still
    # carries the source's id, so overwrite it explicitly - otherwise the original
    # object is replaced in place instead of duplicated (ColliBoy)
    new_obj['id'] = str(uuid.uuid4())[:8]

    store.add_object(session_id, new_obj)

    return jsonify(new_obj)
