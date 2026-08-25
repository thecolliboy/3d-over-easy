"""Read-only endpoints over the per-session operation log.

Exposes the recorded operation history so scripted pipelines can inspect it.
"""
# ColliBoy

from flask import Blueprint, request, jsonify
from app.engine.operations import oplog
from app.models.session import store

bp = Blueprint('operations', __name__)


@bp.route('/log', methods=['GET'])
def get_operations_log():
    """Return every logged operation for a session, optionally filtered by type.

    Query params:
        - session_id (required): the session to query
        - operation_type (optional): keep only entries of this kind (translate, rotate, scale, union, subtract, intersect, ...)

    Response is a JSON array of timestamped operation entries, suitable for driving scripted pipelines.
    """
    session_id = request.args.get('session_id')
    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    try:
        operations = oplog.get_log(session_id)

        # Keep only entries matching the requested operation type when the filter param is set (ColliBoy)
        operation_type = request.args.get('operation_type')
        if operation_type:
            operations = [op for op in operations if op['operation'] == operation_type]

        return jsonify(operations), 200
    except Exception as e:
        return jsonify({'error': f'Failed to retrieve operation log: {str(e)}'}), 500


@bp.route('/summary', methods=['GET'])
def get_operations_summary():
    """Count logged operations grouped by type."""
    session_id = request.args.get('session_id')
    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    try:
        all_ops = oplog.get_log(session_id)
        operation_counts = {}

        for op in all_ops:
            op_type = op['operation']
            operation_counts[op_type] = operation_counts.get(op_type, 0) + 1

        return jsonify({
            'session_id': session_id,
            'total_operations': len(all_ops),
            'operations_by_type': operation_counts,
        }), 200
    except Exception as e:
        return jsonify({'error': f'Failed to retrieve operations summary: {str(e)}'}), 500


@bp.route('/get', methods=['GET'])
def get_operation_by_id():
    """Fetch one log entry by its position in the session's operation list."""
    session_id = request.args.get('session_id')
    index = request.args.get('index', 0, type=int)

    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    try:
        all_ops = oplog.get_log(session_id)
        if index < len(all_ops):
            return jsonify(all_ops[index]), 200
        else:
            return jsonify({'error': f'Index {index} out of range (max: {len(all_ops) - 1})'}), 404
    except Exception as e:
        return jsonify({'error': f'Failed to retrieve operation: {str(e)}'}), 500


@bp.route('/session', methods=['GET'])
def get_session_summary():
    """Report basic facts about a session: age, object count, and undo/redo depth."""
    session_id = request.args.get('session_id')
    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    session = store.get_or_create_session(session_id)

    return jsonify({
        'session_id': session['id'],
        'created_at': session['created_at'],
        'updated_at': session['updated_at'],
        'num_objects': len(session['objects']),
        'undo_count': len(session['undo_stack']),
        'redo_count': len(session['redo_stack']),
    }), 200