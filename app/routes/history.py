"""Undo/redo endpoints for the session operation history.

The store keeps a stack of full-state snapshots per modifying operation;
these routes pop from either side and return the restored state plus updated
history info so the frontend can wipe its scene and reload in one pass.
"""
# ColliBoy

from flask import Blueprint, jsonify, request
from app.models.session import store

bp = Blueprint('history', __name__)


@bp.route('/undo', methods=['POST'])
def history_undo():
    data = request.json or {}
    session_id = data.get('session_id')

    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    # Pop the newest snapshot from the undo side of the operation stack, LIFO (ColliBoy)
    snapshot = store.pop_undo(session_id)
    if not snapshot:
        return jsonify({'error': 'Nothing to undo'}), 409

    # Frontend wipes its scene and reloads from this list; must carry every object in the restored session.
    objects = store.get_all_objects(session_id)
    return jsonify({
        'operation': snapshot['operation'],
        'timestamp': snapshot['timestamp'],
        'objects': objects,
        'history': store.get_history_info(session_id),
    })


@bp.route('/redo', methods=['POST'])
def history_redo():
    data = request.json or {}
    session_id = data.get('session_id')

    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    snapshot = store.pop_redo(session_id)
    if not snapshot:
        return jsonify({'error': 'Nothing to redo'}), 409

    # Same contract as undo - the full restored session, ready for a scene wipe.
    objects = store.get_all_objects(session_id)
    return jsonify({
        'operation': snapshot['operation'],
        'timestamp': snapshot['timestamp'],
        'objects': objects,
        'history': store.get_history_info(session_id),
    })


@bp.route('/info', methods=['GET'])
def history_info():
    session_id = request.args.get('session_id')

    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    info = store.get_history_info(session_id)
    return jsonify(info)
