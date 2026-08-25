"""Tests for OpenAI-compatible provider configs: save/delete/list endpoints and
the /generate routing between local .gguf models and the OpenAI REST API.

The AI routes resolve ai/models (and the per-job scratch dirs) from module-level
constants, so every test points them at a temp folder to keep the real
ai/ directory untouched.
"""
# ColliBoy

import json
import os
import threading

import pytest

# The route module itself: `app.routes` re-exports each blueprint under the
# same short name, so a plain attribute lookup would grab the Blueprint.
import importlib

ai_routes = importlib.import_module('app.routes.ai')
from app import create_app


@pytest.fixture
def ai_client(tmp_path, monkeypatch):
    """Flask test client with the AI model/scratch dirs redirected to temp paths."""
    models_dir = tmp_path / 'models'
    models_dir.mkdir()
    monkeypatch.setattr(ai_routes, 'MODELS_DIR', str(models_dir))
    monkeypatch.setattr(ai_routes, 'INPUT_DIR', str(tmp_path / 'input'))
    monkeypatch.setattr(ai_routes, 'OUTPUT_DIR', str(tmp_path / 'output'))

    app = create_app('default')
    with app.test_client() as client:
        yield client, models_dir


def _write_provider(models_dir, file_name, **fields):
    path = os.path.join(str(models_dir), file_name)
    payload = {
        'provider_name': fields.get('provider_name', ''),
        'url': fields.get('url', ''),
        'api_key': fields.get('api_key', 'none'),
        'model_name': fields.get('model_name', ''),
    }
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f)


class TestListModels:
    def test_returns_gguf_models_and_provider_configs(self, ai_client):
        client, models_dir = ai_client
        (models_dir / 'local-model.gguf').write_bytes(b'not a real model')
        _write_provider(models_dir, 'OpenAI_gpt-4o.json',
                        provider_name='OpenAI', url='https://api.openai.com/v1',
                        api_key='sk-test', model_name='gpt-4o')

        resp = client.get('/api/ai/models')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['models'] == ['local-model.gguf']
        assert len(data['providers']) == 1
        provider = data['providers'][0]
        assert provider['file'] == 'OpenAI_gpt-4o.json'
        assert provider['provider_name'] == 'OpenAI'
        assert provider['url'] == 'https://api.openai.com/v1'
        assert provider['api_key'] == 'sk-test'
        assert provider['model_name'] == 'gpt-4o'

    def test_empty_directory_lists_nothing(self, ai_client):
        client, _ = ai_client
        data = client.get('/api/ai/models').get_json()
        assert data == {'models': [], 'providers': []}


class TestSaveProvider:
    def test_save_creates_json_named_by_provider_and_model(self, ai_client):
        client, models_dir = ai_client
        resp = client.post('/api/ai/provider', json={
            'provider_name': 'OpenAI',
            'url': 'https://api.openai.com/v1',
            'api_key': 'sk-test',
            'model_name': 'gpt-4o',
        })
        assert resp.status_code == 201
        assert resp.get_json()['file'] == 'OpenAI_gpt-4o.json'

        path = models_dir / 'OpenAI_gpt-4o.json'
        assert os.path.isfile(str(path))
        data = json.loads(path.read_text(encoding='utf-8'))
        assert data == {
            'provider_name': 'OpenAI',
            'url': 'https://api.openai.com/v1',
            'api_key': 'sk-test',
            'model_name': 'gpt-4o',
        }

    def test_blank_api_key_defaults_to_none(self, ai_client):
        client, models_dir = ai_client
        resp = client.post('/api/ai/provider', json={
            'provider_name': 'LocalLLM',
            'url': 'http://localhost:8080/v1',
            'model_name': 'qwen2.5-coder',
        })
        assert resp.status_code == 201
        data = json.loads((models_dir / 'LocalLLM_qwen2.5-coder.json').read_text(encoding='utf-8'))
        assert data['api_key'] == 'none'

    def test_duplicate_names_get_incrementing_index(self, ai_client):
        client, models_dir = ai_client
        body = {
            'provider_name': 'OpenAI',
            'url': 'https://api.openai.com/v1',
            'model_name': 'gpt-4o',
        }
        first = client.post('/api/ai/provider', json=body).get_json()['file']
        second = client.post('/api/ai/provider', json=body).get_json()['file']
        third = client.post('/api/ai/provider', json=body).get_json()['file']
        assert (first, second, third) == ('OpenAI_gpt-4o.json', 'OpenAI_gpt-4o_1.json', 'OpenAI_gpt-4o_2.json')

    def test_saving_with_existing_file_updates_in_place(self, ai_client):
        client, models_dir = ai_client
        _write_provider(models_dir, 'MyProvider_model-a.json',
                        provider_name='MyProvider', url='https://old.example/v1',
                        model_name='model-a')

        resp = client.post('/api/ai/provider', json={
            'file': 'MyProvider_model-a.json',
            'provider_name': 'MyProvider',
            'url': 'https://new.example/v1',
            'api_key': 'key-123',
            'model_name': 'model-b',
        })
        assert resp.status_code == 201
        # Same file updated, no new one minted - even though the model name changed.
        assert resp.get_json()['file'] == 'MyProvider_model-a.json'
        files = [f for f in os.listdir(str(models_dir)) if f.endswith('.json')]
        assert files == ['MyProvider_model-a.json']
        data = json.loads((models_dir / 'MyProvider_model-a.json').read_text(encoding='utf-8'))
        assert data['url'] == 'https://new.example/v1'
        assert data['model_name'] == 'model-b'

    def test_missing_required_fields_rejected(self, ai_client):
        client, _ = ai_client
        base = {'provider_name': 'P', 'url': 'https://x/v1', 'model_name': 'm'}
        for missing in ('provider_name', 'url', 'model_name'):
            body = {k: v for k, v in base.items() if k != missing}
            resp = client.post('/api/ai/provider', json=body)
            assert resp.status_code == 400

    def test_path_traversal_in_file_rejected(self, ai_client):
        client, models_dir = ai_client
        _write_provider(models_dir, 'a_b.json', provider_name='a', url='u', model_name='b')
        # The traversal name does not exist under ai/models, so the update must
        # fall back to minting a fresh file instead of touching anything else.
        resp = client.post('/api/ai/provider', json={
            'file': '../../../evil.json',
            'provider_name': 'a',
            'url': 'u',
            'model_name': 'b',
        })
        assert resp.status_code == 201
        assert resp.get_json()['file'] != '../../../evil.json'


class TestDeleteProvider:
    def test_delete_removes_the_file(self, ai_client):
        client, models_dir = ai_client
        _write_provider(models_dir, 'P_m.json', provider_name='P', url='u', model_name='m')

        resp = client.delete('/api/ai/provider/P_m.json')
        assert resp.status_code == 200
        assert not os.path.isfile(str(models_dir / 'P_m.json'))

    def test_delete_unknown_file_returns_404(self, ai_client):
        client, _ = ai_client
        resp = client.delete('/api/ai/provider/nope.json')
        assert resp.status_code == 404


class TestGenerateRouting:
    """Verifies the subprocess command line /generate builds for each backend."""

    def _capture_job(self, monkeypatch):
        captured = {'cmd': None}
        event = threading.Event()

        def fake_run(job_id, cmd):
            captured['cmd'] = cmd
            event.set()

        monkeypatch.setattr(ai_routes, '_run_generation_job', fake_run)
        return captured, event

    def test_provider_payload_builds_api_command(self, ai_client, monkeypatch):
        client, _ = ai_client
        captured, event = self._capture_job(monkeypatch)

        resp = client.post('/api/ai/generate', json={
            'mode': 'create',
            'prompt': 'a cube',
            'model': '__add_openai_api__',
            'provider': {
                'provider_name': 'OpenAI',
                'url': 'https://api.openai.com/v1',
                'api_key': 'sk-test',
                'model_name': 'gpt-4o',
            },
        })
        assert resp.status_code == 202
        assert event.wait(timeout=5)

        cmd = captured['cmd']
        assert '--api-url' in cmd and cmd[cmd.index('--api-url') + 1] == 'https://api.openai.com/v1'
        assert '--model-name' in cmd and cmd[cmd.index('--model-name') + 1] == 'gpt-4o'
        assert '--api-key' in cmd and cmd[cmd.index('--api-key') + 1] == 'sk-test'
        # API mode never loads a local model.
        assert '--model' not in cmd

    def test_provider_without_key_omits_api_flag(self, ai_client, monkeypatch):
        client, _ = ai_client
        captured, event = self._capture_job(monkeypatch)

        resp = client.post('/api/ai/generate', json={
            'mode': 'create',
            'prompt': 'a cube',
            'model': 'OpenAI_gpt-4o.json',
            'provider': {
                'url': 'http://localhost:8080/v1',
                'api_key': 'none',
                'model_name': 'gpt-4o',
            },
        })
        assert resp.status_code == 202
        assert event.wait(timeout=5)

        cmd = captured['cmd']
        assert '--api-url' in cmd
        assert '--api-key' not in cmd

    def test_local_gguf_command_unchanged(self, ai_client, monkeypatch):
        client, models_dir = ai_client
        (models_dir / 'local.gguf').write_bytes(b'x')
        captured, event = self._capture_job(monkeypatch)

        resp = client.post('/api/ai/generate', json={
            'mode': 'create',
            'prompt': 'a cube',
            'model': 'local.gguf',
        })
        assert resp.status_code == 202
        assert event.wait(timeout=5)

        cmd = captured['cmd']
        model_index = cmd.index('--model')
        assert os.path.basename(cmd[model_index + 1]) == 'local.gguf'
        assert '--api-url' not in cmd and '--model-name' not in cmd

    def test_provider_payload_alone_is_valid_without_local_model(self, ai_client, monkeypatch):
        client, _ = ai_client
        captured, event = self._capture_job(monkeypatch)

        # No .gguf files exist at all; the provider payload still routes fine.
        resp = client.post('/api/ai/generate', json={
            'mode': 'create',
            'prompt': 'a cube',
            'model': '',
            'provider': {'url': 'https://x/v1', 'model_name': 'm'},
        })
        assert resp.status_code == 202
        assert event.wait(timeout=5)

    def test_no_backend_selected_rejected(self, ai_client):
        client, _ = ai_client
        resp = client.post('/api/ai/generate', json={
            'mode': 'create',
            'prompt': 'a cube',
            'model': '',
        })
        assert resp.status_code == 400
