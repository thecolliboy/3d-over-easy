"""Import and export endpoints for session meshes.

Covers file uploads in any supported format (stl, obj, ply, glb, gltf, 3mf, fbx)
and single-object, combined, or preset-driven exports back to disk formats.
"""
# ColliBoy

import io
import uuid
import numpy as np
from flask import Blueprint, request, jsonify, send_file
from app.parsers.stl_parser import write_stl
from app.parsers.obj_parser import write_obj as _write_obj
from app.parsers.ply_parser import write_ply as _write_ply
from app.parsers._3mf_parser import write_3mf as _write_3mf
from app.parsers.unified_parser import detect_format, parse_mesh
from app.models.session import store

bp = Blueprint('import_export', __name__)


@bp.route('/health')
def health():
    return {'status': 'ok'}


@bp.route('/export/preset', methods=['GET'])
def export_preset():
    """Preset-driven export: repaired binary STL for printing, a 3MF archive, or a UV-mapped OBJ."""
    session_id = request.args.get('session_id')
    obj_id = request.args.get('object_id')
    preset = request.args.get('preset', 'stl').lower()

    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    objects = store.get_all_objects(session_id)
    if not objects:
        return jsonify({'error': 'No objects in session'}), 404

    # A single object is exported when object_id is given; the whole session otherwise
    if obj_id:
        target_objs = [store.get_object(session_id, obj_id)]
        target_objs = [o for o in target_objs if o]
    else:
        target_objs = objects

    if not target_objs:
        return jsonify({'error': 'Object not found'}), 404

    try:
        if preset == 'print-ready':
            return _export_print_ready(target_objs)
        elif preset == '3mf':
            return _export_3mf(target_objs)
        elif preset == 'obj-texture':
            return _export_obj_texture(target_objs)
        else:
            # Unknown presets fall through to plain format-based export (stl/obj/ply)
            if preset in ('stl', 'obj', 'ply'):
                obj = target_objs[0]
                if preset == 'stl':
                    return _export_stl(obj)
                elif preset == 'obj':
                    return _export_obj(obj)
                elif preset == 'ply':
                    return _export_ply(obj)
            return jsonify({
                'error': f'Unknown preset: {preset}',
                'supported_presets': ['print-ready', '3mf', 'obj-texture'],
                'supported_formats': ['stl', 'obj', 'ply']
            }), 400
    except Exception as e:
        return jsonify({'error': f'Export failed: {str(e)}'}), 500


def _export_print_ready(objects):
    """Run manifold repair over every mesh, then merge them into one binary STL ready for slicing."""
    from app.engine.manifold_wrapper import repair

    all_vertices = []
    all_indices = []
    offset = 0

    for obj in objects:
        vertices = obj['vertices']
        indices = obj.get('indices')

        if isinstance(vertices, list):
            verts_arr = np.array(vertices, dtype=np.float32).reshape(-1, 3)
        else:
            verts_arr = np.asarray(vertices, dtype=np.float32)

        if indices is not None and len(indices) > 0:
            if isinstance(indices, list):
                idxs_arr = np.array(indices, dtype=np.uint32).reshape(-1, 3)
            else:
                idxs_arr = np.asarray(indices, dtype=np.uint32).reshape(-1, 3)
        else:
            # STL carries no index data, so triangle indices are derived from the flat vertex list (ColliBoy)
            idxs_arr = np.arange(len(verts_arr), dtype=np.uint32).reshape(-1, 3)

        try:
            repaired_verts, repaired_idxs = repair(verts_arr, idxs_arr)
        except Exception as e:
            # Fall back to the unrepaired mesh when the repair pass raises
            repaired_verts = verts_arr
            repaired_idxs = idxs_arr

        all_vertices.append(np.asarray(repaired_verts, dtype=np.float32).reshape(-1, 3))
        # Rebase this mesh's index set past every earlier mesh so the merged STL stays valid (ColliBoy)
        all_indices.append((np.asarray(repaired_idxs, dtype=np.uint32).reshape(-1, 3) + offset))
        offset += np.asarray(repaired_verts).reshape(-1, 3).shape[0]

    vertices_array = np.concatenate(all_vertices, axis=0) if all_vertices else np.empty((0, 3), dtype=np.float32)
    indices_array = np.concatenate(all_indices, axis=0) if all_indices else None

    stl_data = write_stl(vertices_array, indices_array, None, binary=True)

    filename = f'{objects[0].get("name", "model")}_print_ready.stl'
    return send_file(
        io.BytesIO(stl_data),
        mimetype='application/sla',
        as_attachment=True,
        download_name=filename,
    )


def _export_3mf(objects):
    """Pack every session object into one 3MF archive, keeping colors and metadata intact."""
    meshes = []
    for obj in objects:
        mesh_data = {
            'vertices': obj['vertices'],
            'indices': obj.get('indices'),
            'name': obj.get('name', 'model'),
        }
        if obj.get('colors'):
            mesh_data['colors'] = obj['colors']
        meshes.append(mesh_data)

    filename = f'{objects[0].get("name", "model")}.3mf'
    data = _write_3mf(meshes)

    return send_file(
        io.BytesIO(data),
        mimetype='application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
        as_attachment=True,
        download_name=filename,
    )


def _export_obj_texture(objects):
    """Write an OBJ with generated UVs so textured models retain their mapping."""
    vertices = []
    normals = []

    for obj in objects:
        # session objects store flat coordinate lists (ColliBoy)
        vertices.extend(obj['vertices'])
        if obj.get('normals'):
            normals.extend(obj['normals'])

    vert_list = vertices if vertices else []
    # write_obj expects per-vertex normals covering every vertex; drop them when merged coverage is incomplete (ColliBoy)
    norm_list = normals if (normals and len(normals) == len(vert_list)) else None

    # UVs are derived from the XY bounding box of the merged vertex set (ColliBoy)
    uv_coords = None
    if vert_list and len(vert_list) % 3 == 0:
        verts_arr = np.array(vert_list, dtype=np.float32).reshape(-1, 3)
        min_x, max_x = float(verts_arr[:, 0].min()), float(verts_arr[:, 0].max())
        min_y, max_y = float(verts_arr[:, 1].min()), float(verts_arr[:, 1].max())
        range_x = (max_x - min_x) or 1.0
        range_y = (max_y - min_y) or 1.0
        uv_coords = [((x - min_x) / range_x, (y - min_y) / range_y)
                     for x, y in zip(verts_arr[:, 0], verts_arr[:, 1])]

    obj_data = _write_obj(vert_list, None, norm_list, objects[0].get('name', 'model'), uv_coords=uv_coords)

    filename = f'{objects[0].get("name", "model")}_textured.obj'
    return send_file(
        io.BytesIO(obj_data),
        mimetype='text/wavefront-obj',
        as_attachment=True,
        download_name=filename,
    )


@bp.route('/import', methods=['POST'])
def import_files():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    files = request.files.getlist('file')
    session_id = request.form.get('session_id')
    results = []

    # Reuse the supplied session or mint a fresh one when none arrives
    session = store.get_or_create_session(session_id)
    actual_session_id = session['id']

    for file in files:
        if not file.filename:
            continue

        filename = file.filename
        file_data = file.read()

        fmt = detect_format(filename, file_data)
        if not fmt:
            return jsonify({
                'error': f'Unsupported format: {filename}',
                'supported': ['stl', 'obj', 'ply', 'glb', 'gltf', '3mf', 'fbx']
            }), 400

        try:
            mesh_data = parse_mesh(filename, file_data)
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        except Exception as e:
            return jsonify({'error': f'Failed to parse {filename}: {str(e)}'}), 400

        obj_id = str(uuid.uuid4())[:8]
        obj = store.add_object(actual_session_id, {
            'id': obj_id,
            'name': filename,
            'format': fmt,
            'vertices': mesh_data['vertices'],
            'indices': mesh_data['indices'],
            'normals': mesh_data['normals'],
            'num_vertices': mesh_data['num_vertices'],
            'num_faces': mesh_data['num_faces'],
        })

        results.append({
            'id': obj['id'],
            'name': obj['name'],
            'format': obj['format'],
            'vertices': obj['vertices'],
            'indices': obj['indices'],
            'normals': obj['normals'],
            'num_vertices': obj['num_vertices'],
            'num_faces': obj['num_faces'],
        })

    return jsonify({
        'objects': results,
        'session_id': actual_session_id,
        'imported_count': len(results),
    })


@bp.route('/export', methods=['GET'])
def export_model():
    session_id = request.args.get('session_id')
    obj_id = request.args.get('object_id')
    fmt = request.args.get('format', 'stl').lower()

    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    if not obj_id:
        objects = store.get_all_objects(session_id)
        if len(objects) == 1:
            obj_id = objects[0]['id']
        elif len(objects) > 1:
            return jsonify({
                'error': 'Multiple objects in session. Specify object_id or use ?all for combined export.'
            }), 400

    obj = store.get_object(session_id, obj_id)
    if not obj:
        return jsonify({'error': f'Object {obj_id} not found'}), 404

    try:
        if fmt == 'stl':
            return _export_stl(obj)
        elif fmt == 'obj':
            return _export_obj(obj)
        elif fmt == 'ply':
            return _export_ply(obj)
        else:
            return jsonify({
                'error': f'Format \".{fmt}\" not yet supported for export.',
                'supported': ['stl', 'obj', 'ply']
            }), 400
    except Exception as e:
        return jsonify({'error': f'Export failed: {str(e)}'}), 500


@bp.route('/export/all', methods=['GET'])
def export_all():
    session_id = request.args.get('session_id')
    fmt = request.args.get('format', 'stl').lower()

    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    objects = store.get_all_objects(session_id)
    if not objects:
        return jsonify({'error': 'No objects in session'}), 404

    try:
        if fmt == 'stl':
            return _export_stl_combined(objects)
        elif fmt == 'obj':
            return _export_obj_combined(objects)
        elif fmt == 'ply':
            return _export_ply_combined(objects)
        else:
            return jsonify({
                'error': f'Combined export for \".{fmt}\" not yet supported.',
                'supported': ['stl', 'obj', 'ply']
            }), 400
    except Exception as e:
        return jsonify({'error': f'Export failed: {str(e)}'}), 500


def _export_stl(obj):
    vertices = obj['vertices']
    indices = obj.get('indices')
    normals = obj.get('normals')

    # Reshape flat coordinate lists into the (N,3) arrays write_stl expects
    if isinstance(vertices, list):
        vertices = np.array(vertices, dtype=np.float32).reshape(-1, 3)
    if isinstance(normals, list):
        normals = np.array(normals, dtype=np.float32).reshape(-1, 3)
    if indices is not None and isinstance(indices, list):
        indices = np.array(indices, dtype=np.uint32).reshape(-1, 3)

    stl_data = write_stl(vertices, indices, normals, binary=True)

    filename = f'{obj["name"] or "model"}.stl'
    return send_file(
        io.BytesIO(stl_data),
        mimetype='application/sla',
        as_attachment=True,
        download_name=filename,
    )


def _export_stl_combined(objects):
    all_vertices = []
    all_indices = []
    offset = 0

    for obj in objects:
        verts = obj['vertices']
        idxs = obj.get('indices')

        # session objects store flat coordinate lists, so the vertex count is len // 3 (ColliBoy)
        vert_count = len(verts) // 3
        if idxs is not None and len(idxs) > 0:
            all_indices.extend(i + offset for i in idxs)
        else:
            # No index data (e.g. STL imports): emit explicit triangle indices so the
            # geometry survives the merge - write_stl only expands indexed triangles,
            # so a bare soup would be dropped once any sibling object is indexed (ColliBoy)
            all_indices.extend(range(offset, offset + vert_count))
        all_vertices.extend(verts)
        # advance for every object so later index sets rebase past unindexed geometry too (ColliBoy)
        offset += vert_count

    # Merge every object into one (N,3) vertex array for the combined STL (ColliBoy)
    vertices_array = np.array(all_vertices, dtype=np.float32).reshape(-1, 3) if all_vertices else np.empty((0, 3), dtype=np.float32)

    # write_stl expects indices as an (F,3) array, matching the single-object export path (ColliBoy)
    indices_array = np.array(all_indices, dtype=np.uint32).reshape(-1, 3) if all_indices else None
    stl_data = write_stl(vertices_array, indices_array, None, binary=True)
    return send_file(
        io.BytesIO(stl_data),
        mimetype='application/sla',
        as_attachment=True,
        download_name='combined_model.stl',
    )


def _export_obj_combined(objects):
    """Merge every session object into one OBJ file, rebasing each index set past the earlier geometry."""
    all_vertices = []
    all_indices = []
    all_normals = []
    offset = 0

    for obj in objects:
        verts = obj['vertices']
        idxs = obj.get('indices')

        vert_count = len(verts) // 3
        if idxs is not None and len(idxs) > 0:
            all_indices.extend(i + offset for i in idxs)
        else:
            # unindexed geometry becomes explicit triangles so the indexed write path keeps it (ColliBoy)
            all_indices.extend(range(offset, offset + vert_count))

        all_vertices.extend(verts)
        if obj.get('normals'):
            all_normals.extend(obj['normals'])
        offset += vert_count

    # The OBJ writer needs per-vertex normals covering every vertex; drop them when coverage is incomplete (ColliBoy)
    norm_list = all_normals if len(all_normals) == len(all_vertices) else None

    obj_data = _write_obj(list(all_vertices), list(all_indices), norm_list, 'combined_model')
    return send_file(
        io.BytesIO(obj_data),
        mimetype='text/wavefront-obj',
        as_attachment=True,
        download_name='combined_model.obj',
    )


def _export_ply_combined(objects):
    """Merge every session object into one PLY file, concatenating per-vertex data."""
    vert_list = []
    norm_list = []
    color_list = []

    for obj in objects:
        verts = obj['vertices']
        if isinstance(verts, list) and len(verts) > 0:
            vert_list.extend([(verts[i], verts[i + 1], verts[i + 2])
                               for i in range(0, len(verts), 3)])

        normals = obj.get('normals')
        if normals and isinstance(normals, list) and len(normals) > 0:
            norm_list.extend([(normals[i], normals[i + 1], normals[i + 2])
                               for i in range(0, len(normals), 3)])

        colors = obj.get('colors')
        if colors and isinstance(colors, list) and len(colors) > 0:
            # Colors may be packed as RGB or RGBA; detect by length and unpack accordingly (ColliBoy)
            stride = 4 if len(colors) % 4 == 0 else 3
            color_list.extend([(colors[i], colors[i + 1], colors[i + 2])
                                for i in range(0, len(colors), stride)])

    # Per-vertex data must cover every vertex or be dropped entirely (ColliBoy)
    norm_out = norm_list if len(norm_list) == len(vert_list) else None
    color_out = color_list if len(color_list) == len(vert_list) else None

    ply_data = _write_ply(vert_list, norm_out, color_out, binary=True)
    return send_file(
        io.BytesIO(ply_data),
        mimetype='application/ply',
        as_attachment=True,
        download_name='combined_model.ply',
    )


def _export_obj(obj):
    vertices = obj['vertices']
    indices = obj.get('indices')
    normals = obj.get('normals')

    # Normalize flat lists to the tuple form write_obj expects
    if isinstance(vertices, list) and len(vertices) > 0:
        vert_list = vertices
    else:
        vert_list = list(vertices) if vertices else []

    idx_list = list(indices) if indices is not None else None
    norm_list = list(normals) if normals is not None else None

    obj_data = _write_obj(vert_list, idx_list, norm_list, obj.get('name', 'model'))

    filename = f'{obj["name"] or "model"}.obj'

    return send_file(
        io.BytesIO(obj_data),
        mimetype='text/wavefront-obj',
        as_attachment=True,
        download_name=filename,
    )


def _export_ply(obj):
    """Serialize a single object as a PLY mesh."""
    vertices = obj['vertices']
    normals = obj.get('normals')
    colors = obj.get('colors')

    # Group flat coordinates into per-vertex tuples for the PLY writer
    if isinstance(vertices, list) and len(vertices) > 0:
        vert_list = [(vertices[i], vertices[i + 1], vertices[i + 2])
                     for i in range(0, len(vertices), 3)]
    else:
        vert_list = []

    norm_list = None
    if normals and isinstance(normals, list) and len(normals) > 0:
        norm_list = [(normals[i], normals[i + 1], normals[i + 2])
                     for i in range(0, len(normals), 3)]

    color_list = None
    if colors and isinstance(colors, list) and len(colors) > 0:
        # Colors may be packed as RGB or RGBA; detect by length and unpack accordingly (ColliBoy)
        stride = 4 if len(colors) % 4 == 0 else 3
        color_list = [(colors[i], colors[i + 1], colors[i + 2]) for i in range(0, len(colors), stride)]

    ply_data = _write_ply(vert_list, norm_list, color_list, binary=True)

    filename = f'{obj["name"] or "model"}.ply'
    return send_file(
        io.BytesIO(ply_data),
        mimetype='application/ply',
        as_attachment=True,
        download_name=filename,
    )
