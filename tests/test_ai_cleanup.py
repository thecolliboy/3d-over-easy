"""Tests for AI mode scratch cleanup: the residual-dir sweep on first open and
the per-job dir removal when a job finishes, both gated by .config's
cleanup_enabled.

The AI routes resolve ai/input + ai/output from module-level constants, so
every test points them at temp folders to keep the real ai/ directory untouched.
"""
# ColliBoy

import os

import pytest

# The route module itself: `app.routes` re-exports each blueprint under the
# same short name, so a plain attribute lookup would grab the Blueprint.
import importlib

ai_routes = importlib.import_module('app.routes.ai')
from app import create_app


@pytest.fixture
def ai_client(tmp_path, monkeypatch):
    """Flask test client with the AI model/scratch dirs redirected to temp paths."""
    input_dir = tmp_path / 'input'
    output_dir = tmp_path / 'output'
    models_dir = tmp_path / 'models'
    for d in (input_dir, output_dir, models_dir):
        d.mkdir()
    monkeypatch.setattr(ai_routes, 'MODELS_DIR', str(models_dir))
    monkeypatch.setattr(ai_routes, 'INPUT_DIR', str(input_dir))
    monkeypatch.setattr(ai_routes, 'OUTPUT_DIR', str(output_dir))

    app = create_app('default')
    with app.test_client() as client:
        yield client, input_dir, output_dir


def _register_running_job(job_id, input_dir, output_dir):
    """Insert a fake in-flight job so the sweep treats its dirs as active."""
    (input_dir / job_id).mkdir(exist_ok=True)
    (output_dir / job_id).mkdir(exist_ok=True)
    with ai_routes._jobs_lock:
        ai_routes._jobs[job_id] = {
            'status': 'running',
            'input_dir': str(input_dir / job_id),
            'output_dir': str(output_dir / job_id),
        }


class TestCleanupEndpoint:
    def test_removes_residual_dirs(self, ai_client):
        client, input_dir, output_dir = ai_client
        (input_dir / 'dead-job-1').mkdir()
        (output_dir / 'dead-job-1').mkdir()
        (output_dir / 'dead-job-2').mkdir()

        resp = client.post('/api/ai/cleanup')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['cleanup_enabled'] is True
        assert data['removed'] == 3
        # Both scratch roots are empty afterwards.
        assert os.listdir(str(input_dir)) == []
        assert os.listdir(str(output_dir)) == []

    def test_preserves_running_job_dirs(self, ai_client):
        client, input_dir, output_dir = ai_client
        job_id = 'livejob001'
        _register_running_job(job_id, input_dir, output_dir)
        (input_dir / 'dead-job-1').mkdir()

        try:
            resp = client.post('/api/ai/cleanup')
            assert resp.status_code == 200
            # The running job's dirs must survive the sweep; only the residual is gone.
            assert os.path.isdir(str(input_dir / job_id))
            assert os.path.isdir(str(output_dir / job_id))
            assert not os.path.exists(str(input_dir / 'dead-job-1'))
        finally:
            with ai_routes._jobs_lock:
                del ai_routes._jobs[job_id]

    def test_disabled_by_config_is_noop(self, ai_client, monkeypatch):
        client, input_dir, output_dir = ai_client
        (input_dir / 'dead-job-1').mkdir()
        (output_dir / 'dead-job-1').mkdir()
        monkeypatch.setattr(ai_routes, 'load_settings', lambda: {'ai_generation': {'cleanup_enabled': False}})

        resp = client.post('/api/ai/cleanup')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['cleanup_enabled'] is False
        assert data['removed'] == 0
        # The dirs are left untouched.
        assert os.listdir(str(input_dir)) == ['dead-job-1']
        assert os.listdir(str(output_dir)) == ['dead-job-1']


class TestFinishJobCleanup:
    """_finish_job removes the job's own scratch dirs on completion, unless disabled."""

    def _register_job(self, input_dir, output_dir):
        job_id = 'finishjob01'
        (input_dir / job_id).mkdir()
        (output_dir / job_id).mkdir()
        with ai_routes._jobs_lock:
            ai_routes._jobs[job_id] = {
                'status': 'running',
                'input_dir': str(input_dir / job_id),
                'output_dir': str(output_dir / job_id),
            }
        return job_id

    def test_finish_removes_job_dirs_when_enabled(self, ai_client):
        _, input_dir, output_dir = ai_client
        job_id = self._register_job(input_dir, output_dir)

        try:
            ai_routes._finish_job(job_id, status='done')
            assert not os.path.exists(str(input_dir / job_id))
            assert not os.path.exists(str(output_dir / job_id))
        finally:
            with ai_routes._jobs_lock:
                del ai_routes._jobs[job_id]

    def test_finish_keeps_job_dirs_when_disabled(self, ai_client, monkeypatch):
        _, input_dir, output_dir = ai_client
        job_id = self._register_job(input_dir, output_dir)
        monkeypatch.setattr(ai_routes, 'load_settings', lambda: {'ai_generation': {'cleanup_enabled': False}})

        try:
            ai_routes._finish_job(job_id, status='done')
            assert os.path.isdir(str(input_dir / job_id))
            assert os.path.isdir(str(output_dir / job_id))
        finally:
            with ai_routes._jobs_lock:
                del ai_routes._jobs[job_id]
