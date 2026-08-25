"""Generation blueprint: model-driven geometry jobs with live progress.

Routes, mounted under whatever url_prefix the app factory gives this
blueprint (the rest of the codebase mounts blueprints at '/api/...' paths -
mount this one at the prefix main.js's APIClient uses for generation):

    GET  /models          -> {'models': [<gguf filenames in ai/models>],
                               'providers': [{file, provider_name, url,
                                              api_key, model_name}, ...]}
    POST /provider        -> saves an OpenAI-compatible API config as a json
                              file in ai/models (updates the named file when
                              given one, otherwise mints <name>_<model>.json
                              with an incrementing index on duplicates)
    DELETE /provider/<f>  -> deletes a saved provider json config
    POST /cleanup         -> sweeps residual job folders from ai/input + ai/output
                               (called when AI mode is first opened; no-op when
                               cleanup_enabled = false in .config)
    POST /generate        -> starts a background job, returns {'job_id': ...}
    GET  /status/<job_id> -> current progress, or the finished result/error
    POST /cancel/<job_id> -> asks a running job to stop

Generation runs ai/run_agent.py as a subprocess on a worker thread instead of
blocking the request: slow hardware can take minutes per iteration, and a
single blocking HTTP call has no way to report progress or be cancelled
mid-flight. The frontend polls /status/<job_id> to drive its progress bar and
can hit /cancel/<job_id> (Stop button) to kill the subprocess without racing
the generate request itself.

Two backends: local .gguf files in ai/models (default), or an OpenAI-
compatible REST API described by a saved provider json config - when /generate
receives a 'provider' payload it passes --api-url/--model-name (and optional
--api-key) to the runner instead of a local model path.

Depends on app.models.session.store exposing get_object, add_object,
remove_object, and get_or_create_session - the same interface used by
primitives.py and csg.py.
"""
# ColliBoy
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import uuid

import numpy as np
from flask import Blueprint, request, jsonify

from app.models.session import store
from app.settings import load_settings

bp = Blueprint('ai', __name__)

# this module sits in app/routes; AI_ROOT resolves up to the project's
# top-level ai/ folder (models/, prompts/, input/, output/, run_agent.py)
from app.paths import project_root
PROJECT_ROOT = project_root()
AI_ROOT = os.path.join(PROJECT_ROOT, 'ai')
MODELS_DIR = os.path.join(AI_ROOT, 'models')
PROMPTS_DIR = os.path.join(AI_ROOT, 'prompts')
INPUT_DIR = os.path.join(AI_ROOT, 'input')
OUTPUT_DIR = os.path.join(AI_ROOT, 'output')
RUNNER_SCRIPT = os.path.join(AI_ROOT, 'run_agent.py')

# In-memory job table: one entry per /generate call's background subprocess.
# Guarded by _jobs_lock because both the request thread (starting or
# cancelling a job) and the job's own worker thread touch it. Nothing is
# persisted - a server restart drops in-flight jobs.
_jobs_lock = threading.Lock()
_jobs = {}

# How long a finished entry lingers after completion, so a frontend poll
# landing just after the job ends still finds it instead of hitting a 404.
_JOB_RETENTION_SECONDS = 300

# Matches the runner's "PROGRESS: stage|iteration|max|message" lines
# (iteration/max may be blank), which drive the progress bar without a
# custom IPC channel.
_PROGRESS_RE = re.compile(r'^PROGRESS:\s*(.*)$')


def _runner_command():
    """Command that launches ai/run_agent.py: the bundled run_agent executable when frozen, else python3."""
    if getattr(sys, 'frozen', False):
        base = os.path.dirname(os.path.abspath(sys.executable))
        name = 'run_agent.exe' if os.name == 'nt' else 'run_agent'
        candidate = os.path.join(base, name)
        if os.path.exists(candidate):
            return [candidate]
    return ['python3', '-u', RUNNER_SCRIPT]


def _prune_old_jobs():
    cutoff = time.time() - _JOB_RETENTION_SECONDS
    with _jobs_lock:
        stale = [
            jid for jid, job in _jobs.items()
            if job['status'] in ('done', 'error', 'cancelled')
            and job.get('finished_at') is not None
            and job['finished_at'] < cutoff
        ]
        for jid in stale:
            del _jobs[jid]


def _update_job(job_id, **fields):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is not None:
            job.update(fields)


def _safe_model_name(name):
    """Accept only bare filenames; block any path-traversal attempt."""
    if not name or not isinstance(name, str):
        return None
    if '/' in name or '\\' in name or name in ('.', '..'):
        return None
    return name


def _safe_provider_file(name):
    """Accept only bare .json filenames; block any path-traversal attempt."""
    if not name or not isinstance(name, str):
        return None
    if '/' in name or '\\' in name or name in ('.', '..'):
        return None
    if not name.lower().endswith('.json'):
        return None
    return name


def _sanitize_name_part(part):
    """Reduce a provider/model name to something safe to use inside a filename."""
    part = (part or '').strip()
    for ch in ('/', '\\', '\0'):
        part = part.replace(ch, '_')
    return part.strip()


def _unique_provider_filename(base):
    """Return base.json, or base_1.json / base_2.json ... when already taken."""
    candidate = f'{base}.json'
    index = 1
    while os.path.exists(os.path.join(MODELS_DIR, candidate)):
        candidate = f'{base}_{index}.json'
        index += 1
    return candidate


def _list_providers():
    """Read every provider json config in ai/models into a display-ready dict."""
    providers = []
    for f in sorted(os.listdir(MODELS_DIR)):
        path = os.path.join(MODELS_DIR, f)
        if not (f.lower().endswith('.json') and os.path.isfile(path)):
            continue
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                data = json.load(fh)
        except Exception:
            # Corrupt/unreadable file - skip it rather than failing the whole list.
            continue
        providers.append({
            'file': f,
            'provider_name': str(data.get('provider_name') or ''),
            'url': str(data.get('url') or ''),
            'api_key': str(data.get('api_key') or 'none'),
            'model_name': str(data.get('model_name') or ''),
        })
    return providers


def _cleanup_enabled():
    """Whether AI mode scratch cleanup is on (.config [ai_generation] cleanup_enabled).

    Read at call time so editing .config takes effect without a restart, the same
    way /generate reads its tuning values."""
    return bool(load_settings().get('ai_generation', {}).get('cleanup_enabled', True))


def _sweep_residual_dirs():
    """Delete job scratch dirs in ai/input + ai/output that don't belong to a running job.

    Per-job cleanup only runs while this server process is alive, so jobs whose
    server died mid-run (crash/restart) leave their folders behind; this sweep
    removes those leftovers. Dirs of currently running jobs are left alone."""
    with _jobs_lock:
        active = set()
        for job in _jobs.values():
            if job['status'] == 'running':
                if job.get('input_dir'):
                    active.add(job['input_dir'])
                if job.get('output_dir'):
                    active.add(job['output_dir'])

    removed = 0
    for base in (INPUT_DIR, OUTPUT_DIR):
        if not os.path.isdir(base):
            continue
        for name in os.listdir(base):
            path = os.path.join(base, name)
            if os.path.isdir(path) and path not in active:
                shutil.rmtree(path, ignore_errors=True)
                removed += 1
    return removed


@bp.route('/cleanup', methods=['POST'])
def cleanup_scratch():
    """Sweep residual job folders from ai/input + ai/output.

    The frontend calls this when AI mode is first opened so leftovers from a
    crashed run don't linger on disk. No-op (and reported as such) when the
    user disabled cleanup in .config."""
    if not _cleanup_enabled():
        return jsonify({'removed': 0, 'cleanup_enabled': False})
    removed = _sweep_residual_dirs()
    print(f'[ai] cleanup: removed {removed} residual scratch dir(s)', flush=True)
    return jsonify({'removed': removed, 'cleanup_enabled': True})


@bp.route('/models', methods=['GET'])
def list_models():
    os.makedirs(MODELS_DIR, exist_ok=True)
    models = sorted(
        f for f in os.listdir(MODELS_DIR)
        if f.lower().endswith('.gguf') and os.path.isfile(os.path.join(MODELS_DIR, f))
    )
    return jsonify({'models': models, 'providers': _list_providers()})


@bp.route('/provider', methods=['POST'])
def save_provider():
    data = request.json or {}
    provider_name = _sanitize_name_part(data.get('provider_name'))
    url = (data.get('url') or '').strip()
    api_key = (data.get('api_key') or '').strip() or 'none'
    model_name = _sanitize_name_part(data.get('model_name'))

    if not provider_name:
        return jsonify({'error': 'provider_name is required'}), 400
    if not url:
        return jsonify({'error': 'url is required'}), 400
    if not model_name:
        return jsonify({'error': 'model_name is required'}), 400

    os.makedirs(MODELS_DIR, exist_ok=True)

    # When the frontend names an existing config file, update it in place;
    # otherwise mint a fresh <provider>_<model>.json (indexed on duplicates).
    existing_file = _safe_provider_file(data.get('file'))
    if existing_file and os.path.isfile(os.path.join(MODELS_DIR, existing_file)):
        file_name = existing_file
    else:
        file_name = _unique_provider_filename(f'{provider_name}_{model_name}')

    payload = {
        'provider_name': provider_name,
        'url': url,
        'api_key': api_key,
        'model_name': model_name,
    }
    with open(os.path.join(MODELS_DIR, file_name), 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)

    return jsonify({'file': file_name}), 201


@bp.route('/provider/<file>', methods=['DELETE'])
def delete_provider(file):
    safe = _safe_provider_file(file)
    if not safe or not os.path.isfile(os.path.join(MODELS_DIR, safe)):
        return jsonify({'error': f'unknown provider config: {file}'}), 404
    os.remove(os.path.join(MODELS_DIR, safe))
    return jsonify({'status': 'deleted'})


def _write_binary_stl(path, vertices, tri_indices):
    """Serialize a mesh to a minimal binary STL payload at path."""
    verts = np.asarray(vertices, dtype=np.float32).reshape(-1, 3)
    tris = np.asarray(tri_indices, dtype=np.uint32).reshape(-1, 3)
    with open(path, 'wb') as f:
        f.write(b'\0' * 80)
        f.write(struct.pack('<I', len(tris)))
        for tri in tris:
            v0, v1, v2 = verts[tri[0]], verts[tri[1]], verts[tri[2]]
            normal = np.cross(v1 - v0, v2 - v0)
            norm_len = np.linalg.norm(normal)
            if norm_len > 1e-12:
                normal = normal / norm_len
            f.write(struct.pack('<3f', *normal))
            f.write(struct.pack('<3f', *v0))
            f.write(struct.pack('<3f', *v1))
            f.write(struct.pack('<3f', *v2))
            f.write(struct.pack('<H', 0))


def _merge_vertices(vertices, tri_indices):
    rounded = np.round(vertices, decimals=6)
    unique_verts, inverse = np.unique(rounded, axis=0, return_inverse=True)
    merged_indices = inverse[tri_indices].astype(np.uint32)
    return unique_verts, merged_indices


def _read_stl(path):
    """Read an STL file in either layout and return welded (vertices, tri_indices)."""
    with open(path, 'rb') as f:
        header = f.read(80)
        rest = f.read()

    is_binary = False
    if len(rest) >= 4:
        (count,) = struct.unpack('<I', rest[:4])
        if len(rest) - 4 == count * 50:
            is_binary = True

    verts = []
    tris = []
    if is_binary:
        body = rest[4:]
        for i in range(count):
            chunk = body[i * 50:(i + 1) * 50]
            floats = struct.unpack('<12f', chunk[:48])
            base = len(verts)
            verts.extend([floats[3:6], floats[6:9], floats[9:12]])
            tris.append((base, base + 1, base + 2))
    else:
        text = (header + rest).decode('utf-8', errors='ignore')
        loose = []
        for line in text.splitlines():
            line = line.strip()
            if line.startswith('vertex'):
                parts = line.split()[1:4]
                loose.append(tuple(float(p) for p in parts))
        for i in range(0, len(loose) - 2, 3):
            base = len(verts)
            verts.extend(loose[i:i + 3])
            tris.append((base, base + 1, base + 2))

    verts = np.array(verts, dtype=np.float32).reshape(-1, 3)
    tris = np.array(tris, dtype=np.uint32).reshape(-1, 3)
    return _merge_vertices(verts, tris)


@bp.route('/generate', methods=['POST'])
def generate():
    data = request.json or {}
    mode = data.get('mode')
    prompt_text = (data.get('prompt') or '').strip()
    session_id = data.get('session_id')
    object_id = data.get('object_id')

    # Optional OpenAI-compatible API routing: when the frontend sends a filled-in
    # provider payload, the runner talks to that REST endpoint instead of loading
    # a local .gguf file. api_key may be blank/'none' for keyless local servers.
    provider = data.get('provider') if isinstance(data.get('provider'), dict) else None
    provider_url = str(provider.get('url') or '').strip() if provider else ''
    provider_model = str(provider.get('model_name') or '').strip() if provider else ''
    provider_key = (str(provider.get('api_key') or '').strip() if provider else '') or 'none'

    use_api = bool(provider_url and provider_model)

    model_name = None
    model_path = None
    if not use_api:
        model_name = _safe_model_name(data.get('model'))
        if not model_name:
            return jsonify({'error': 'a valid model must be selected'}), 400
        model_path = os.path.join(MODELS_DIR, model_name)
        if not os.path.isfile(model_path):
            return jsonify({'error': f'model not found: {model_name}'}), 404

    if mode not in ('create', 'edit'):
        return jsonify({'error': "mode must be 'create' or 'edit'"}), 400
    if not prompt_text:
        return jsonify({'error': 'prompt is required'}), 400
    if mode == 'edit' and (not session_id or not object_id):
        return jsonify({'error': 'session_id and object_id are required for edit mode'}), 400

    prompt_template_name = 'edit-prompt.txt' if mode == 'edit' else 'create-prompt.txt'
    prompt_template_path = os.path.join(PROMPTS_DIR, prompt_template_name)
    if not os.path.isfile(prompt_template_path):
        return jsonify({'error': f'Missing prompt template: {prompt_template_name}'}), 500

    input_vertices = None
    input_tris = None
    if mode == 'edit':
        obj = store.get_object(session_id, object_id)
        if obj is None:
            return jsonify({'error': f'Object {object_id} not found'}), 404
        input_vertices = np.array(obj['vertices'], dtype=np.float32).reshape(-1, 3)
        if obj.get('indices'):
            input_tris = np.array(obj['indices'], dtype=np.uint32).reshape(-1, 3)
        else:
            num_faces = len(input_vertices) // 3
            input_tris = np.arange(num_faces * 3, dtype=np.uint32).reshape(-1, 3)

    _prune_old_jobs()

    # Per-job scratch dirs keep two concurrent generations from stomping on
    # each other's files while the first is still winding down.
    job_id = uuid.uuid4().hex[:12]
    job_input_dir = os.path.join(INPUT_DIR, job_id)
    job_output_dir = os.path.join(OUTPUT_DIR, job_id)
    os.makedirs(job_input_dir, exist_ok=True)
    os.makedirs(job_output_dir, exist_ok=True)

    input_path = None
    if mode == 'edit':
        input_path = os.path.join(job_input_dir, f'{object_id}.stl')
        _write_binary_stl(input_path, input_vertices, input_tris)

    cmd = _runner_command() + [
        # -u (when using python3) keeps stdout/stderr unbuffered so PROGRESS lines
        # reach us line-by-line in real time instead of sitting in a buffer.
        '--mode', mode,
    ]
    if use_api:
        cmd += ['--api-url', provider_url, '--model-name', provider_model]
        if provider_key != 'none':
            cmd += ['--api-key', provider_key]
    else:
        cmd += ['--model', model_path]
    cmd += [
        '--prompt-template', prompt_template_path,
        '--user-request', prompt_text,
        '--output-dir', job_output_dir,
    ]
    if input_path:
        cmd += ['--input-path', input_path]

    # Generation tuning from .config ([ai_generation]): per-turn token budget, max
    # build/fix cycles, and an optional reasoning level for the API model. Read at
    # request time so editing .config takes effect on the next generation.
    gen = load_settings().get('ai_generation', {})
    cmd += [
        '--max-tokens', str(int(gen.get('max_tokens_per_turn', 4096))),
        '--max-iterations', str(int(gen.get('max_iterations', 12))),
    ]
    reasoning_effort = str(gen.get('reasoning_effort', 'low') or '').strip()
    if reasoning_effort and reasoning_effort != 'none':
        cmd += ['--reasoning-effort', reasoning_effort]

    job = {
        'status': 'running',
        'stage': 'starting',
        'message': 'Starting AI generation…',
        'iteration': None,
        'max_iterations': None,
        'mode': mode,
        'session_id': session_id,
        'object_id': object_id,
        'input_dir': job_input_dir,
        'output_dir': job_output_dir,
        'proc': None,
        'error': None,
        'result': None,
        'finished_at': None,
        'cancel_requested': False,
    }
    with _jobs_lock:
        _jobs[job_id] = job

    thread = threading.Thread(target=_run_generation_job, args=(job_id, cmd), daemon=True)
    thread.start()

    return jsonify({'job_id': job_id}), 202


@bp.route('/status/<job_id>', methods=['GET'])
def job_status(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return jsonify({'error': 'unknown job'}), 404
        payload = {
            'status': job['status'],
            'stage': job.get('stage'),
            'message': job.get('message'),
            'iteration': job.get('iteration'),
            'max_iterations': job.get('max_iterations'),
        }
        if job['status'] == 'done':
            payload['result'] = job.get('result')
        elif job['status'] == 'error':
            payload['error'] = job.get('error') or 'AI generation failed'
    return jsonify(payload)


@bp.route('/cancel/<job_id>', methods=['POST'])
def cancel_job(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return jsonify({'error': 'unknown job'}), 404
        if job['status'] != 'running':
            # Already finished/cancelled/errored - nothing to do, but not an
            # error either; the Stop button and the poll loop can race.
            return jsonify({'status': job['status']})
        job['cancel_requested'] = True
        proc = job.get('proc')

    if proc is not None:
        try:
            proc.terminate()
        except Exception:
            pass

        def _force_kill():
            # Give the subprocess a few seconds to exit after SIGTERM (it may
            # be mid-token-generation); escalate if it lingers, so a stuck
            # process cannot block the Stop button.
            time.sleep(5)
            if proc.poll() is None:
                try:
                    proc.kill()
                except Exception:
                    pass

        threading.Thread(target=_force_kill, daemon=True).start()

    return jsonify({'status': 'cancelling'})


def _failure_detail(log_tail):
    """Reduce the runner's output tail to a short reason for the frontend alert.

    PROGRESS lines are machine noise (the progress bar already consumed them),
    so keep only the last few real output lines - in failure cases that is the
    runner's own one-line explanation of what went wrong."""
    lines = [ln.strip() for ln in log_tail if ln.strip() and not ln.startswith('PROGRESS:')]
    return '\n'.join(lines[-3:])[:1000] or 'AI generation failed'


def _run_generation_job(job_id, cmd):
    print(f'[ai:{job_id}] starting: {" ".join(cmd)}', flush=True)
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            # Merge stderr into stdout: one ordered stream of everything the
            # runner (and llama.cpp underneath it) prints, echoed live to
            # this server's console as it happens.
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except Exception as e:
        print(f'[ai:{job_id}] failed to start subprocess: {e}', flush=True)
        _finish_job(job_id, status='error', error=f'Failed to start AI process: {e}')
        return

    _update_job(job_id, proc=proc)

    log_tail = []
    try:
        for line in proc.stdout:
            line = line.rstrip('\n')
            if not line:
                continue
            print(f'[ai:{job_id}] {line}', flush=True)
            log_tail.append(line)
            if len(log_tail) > 200:
                # keep only the tail so failure reports stay bounded (ColliBoy)
                log_tail.pop(0)

            match = _PROGRESS_RE.match(line)
            if match:
                parts = match.group(1).split('|', 3)
                stage = parts[0]
                iteration_raw = parts[1] if len(parts) > 1 else ''
                max_iter_raw = parts[2] if len(parts) > 2 else ''
                message = parts[3] if len(parts) > 3 else stage
                _update_job(
                    job_id,
                    stage=stage,
                    message=message,
                    iteration=int(iteration_raw) if iteration_raw else None,
                    max_iterations=int(max_iter_raw) if max_iter_raw else None,
                )
    except Exception as e:
        print(f'[ai:{job_id}] error while reading subprocess output: {e}', flush=True)

    returncode = proc.wait()

    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            # The job entry was already pruned - nothing left to report into.
            return
        cancelled = bool(job.get('cancel_requested'))
        output_dir = job['output_dir']
        mode = job['mode']
        session_id = job['session_id']
        object_id = job['object_id']

    if cancelled:
        print(f'[ai:{job_id}] cancelled', flush=True)
        _finish_job(job_id, status='cancelled')
        return

    if returncode != 0:
        print(f'[ai:{job_id}] process exited with code {returncode}', flush=True)
        _finish_job(job_id, status='error', error=_failure_detail(log_tail))
        return

    output_files = [
        f for f in os.listdir(output_dir)
        if f.lower().endswith('.stl') and os.path.isfile(os.path.join(output_dir, f))
    ]
    if not output_files:
        _finish_job(job_id, status='error', error='AI did not produce an output model')
        return

    output_path = os.path.join(output_dir, sorted(output_files)[0])
    try:
        result_verts, result_tris = _read_stl(output_path)
    except Exception as e:
        _finish_job(job_id, status='error', error=f'Failed to read AI output model: {str(e)}')
        return

    verts_flat = result_verts.flatten().tolist()
    tris_flat = result_tris.flatten().tolist()

    if not session_id:
        session = store.get_or_create_session(None)
        session_id = session['id']

    if mode == 'edit':
        obj_prev = store.get_object(session_id, object_id) or {}
        new_obj = {
            'id': str(uuid.uuid4())[:8],
            'name': obj_prev.get('name', 'ai_edit_result'),
            'format': 'mesh',
            'vertices': verts_flat,
            'indices': tris_flat,
            'normals': None,
            'num_vertices': int(len(result_verts)),
            'num_faces': int(len(result_tris)),
        }
        store.add_object(session_id, new_obj)
        store.remove_object(session_id, object_id)

        response = dict(new_obj)
        response['previous_object_id'] = object_id
        response['session_id'] = session_id
        _finish_job(job_id, status='done', result=response)
        return

    new_obj = {
        'id': str(uuid.uuid4())[:8],
        'name': 'ai_create_result',
        'format': 'mesh',
        'vertices': verts_flat,
        'indices': tris_flat,
        'num_vertices': int(len(result_verts)),
        'num_faces': int(len(result_tris)),
    }
    store.add_object(session_id, new_obj)
    result_obj = dict(new_obj)
    result_obj['session_id'] = session_id
    _finish_job(job_id, status='done', result={'objects': [result_obj], 'session_id': session_id})


def _finish_job(job_id, status, result=None, error=None):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job['status'] = status
        job['result'] = result
        job['error'] = error
        job['finished_at'] = time.time()
        job['proc'] = None
        input_dir = job.get('input_dir')
        output_dir = job.get('output_dir')

    # Scratch dirs are per-job, so removing them here cannot touch another
    # in-flight job's files. Skipped entirely when cleanup is disabled in .config.
    if _cleanup_enabled():
        if input_dir:
            shutil.rmtree(input_dir, ignore_errors=True)
        if output_dir:
            shutil.rmtree(output_dir, ignore_errors=True)
