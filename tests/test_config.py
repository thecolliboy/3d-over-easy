"""Tests for the .config editor endpoints (GET/POST /api/config) and the
save_settings writer that regenerates the commented TOML file.

The POST route writes to app.settings.CONFIG_PATH, so tests redirect it
to a temp path via monkeypatch to keep the real .config untouched.
"""
# ColliBoy

import tomllib

import pytest

from app import create_app
from app import settings as app_settings


@pytest.fixture
def config_client(tmp_path, monkeypatch):
    """Flask test client with CONFIG_PATH redirected to a temp file."""
    config_file = tmp_path / '.config'
    monkeypatch.setattr(app_settings, 'CONFIG_PATH', str(config_file))

    app = create_app('default')
    with app.test_client() as client:
        yield client, config_file


class TestGetConfig:
    def test_returns_all_sections_including_webserver(self, config_client):
        client, _ = config_client
        resp = client.get('/api/config')
        assert resp.status_code == 200
        data = resp.get_json()
        # Every section of .config is exposed for editing, webserver included.
        assert set(data.keys()) == {
            'webserver', 'viewport', 'build_plate', 'snap', 'ui', 'import', 'ai_generation'
        }

    def test_settings_endpoint_still_excludes_webserver(self, config_client):
        client, _ = config_client
        data = client.get('/api/settings').get_json()
        assert 'webserver' not in data

    def test_descriptions_cover_every_known_key(self, config_client):
        client, _ = config_client
        resp = client.get('/api/config/descriptions')
        assert resp.status_code == 200
        data = resp.get_json()
        # One help line per known key; the popup shows it under each option.
        for section, values in app_settings.DEFAULTS.items():
            assert set(data[section]) == set(values)


class TestPostConfig:
    def test_saves_value_and_persists_to_file(self, config_client):
        client, config_file = config_client

        resp = client.post('/api/config', json={'ui': {'theme': 'day'}, 'viewport': {'camera_far': 500}})
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['ui']['theme'] == 'day'
        assert data['viewport']['camera_far'] == 500

        # The change is written to disk as valid TOML with the right types.
        with open(config_file, 'rb') as f:
            on_disk = tomllib.load(f)
        assert on_disk['ui']['theme'] == 'day'
        assert on_disk['viewport']['camera_far'] == 500

    def test_preserves_unchanged_keys(self, config_client):
        client, _ = config_client
        # Untouched keys keep their built-in defaults after a partial save.
        resp = client.post('/api/config', json={'ui': {'units': 'cm'}})
        data = resp.get_json()
        assert data['ui']['units'] == 'cm'
        assert data['webserver']['port'] == 8181  # default, not in payload

    def test_rejects_non_numeric_int(self, config_client):
        client, _ = config_client
        resp = client.post('/api/config', json={'webserver': {'port': 'not-a-number'}})
        assert resp.status_code == 400
        assert 'error' in resp.get_json()

    def test_rejects_bool_for_int_key(self, config_client):
        client, _ = config_client
        resp = client.post('/api/config', json={'webserver': {'workers': True}})
        assert resp.status_code == 400

    def test_accepts_numeric_string_for_number_keys(self, config_client):
        client, _ = config_client
        # The frontend sends numbers; the backend also tolerates numeric strings.
        resp = client.post('/api/config', json={'webserver': {'port': '9000'}})
        assert resp.status_code == 200
        assert resp.get_json()['webserver']['port'] == 9000

    def test_ignores_unknown_sections_and_keys(self, config_client):
        client, _ = config_client
        resp = client.post('/api/config', json={'bogus': {'x': 1}, 'ui': {'nope': 5, 'units': 'in'}})
        assert resp.status_code == 200
        data = resp.get_json()
        # Unknowns are dropped; the known key is applied.
        assert 'bogus' not in data
        assert 'nope' not in data['ui']
        assert data['ui']['units'] == 'in'

    def test_rejects_non_dict_body(self, config_client):
        client, _ = config_client
        resp = client.post('/api/config', json=['not', 'a', 'dict'])
        assert resp.status_code == 400


class TestSaveSettingsWriter:
    """save_settings regenerates a complete, commented, valid-TOML file."""

    def test_round_trips_all_types(self, tmp_path):
        config_file = tmp_path / '.config'
        values = {
            'webserver': {'host': '0.0.0.0', 'port': 9000, 'workers': 1, 'open_browser': False, 'local_libraries': True},
            'viewport': {'smooth_shading': True, 'lod_enabled': False, 'view_mode': 'wireframe', 'camera_far': 5000},
            'build_plate': {'visible': False, 'infinite': True, 'simple_plate': True, 'axis_lines_visible': False, 'default_size_mm': 25.5},
            'snap': {'grid_enabled': True, 'grid_size_mm': 2.0, 'smart_enabled': False},
            'ui': {'units': 'in', 'theme': 'day', 'aesthetic_mode': True, 'even_lighting': False,
                    'messages_muted': True, 'rotate_pivot': 'origin', 'preview_shrink': False, 'tip_mode': True,
                    'view_cube_visible': True},
            'import': {'separation_enabled': False, 'min_gap_mm': 7.5},
            'ai_generation': {'max_tokens_per_turn': 8192, 'max_iterations': 3, 'reasoning_effort': 'high', 'cleanup_enabled': False},
        }
        app_settings.save_settings(values, str(config_file))

        with open(config_file, 'rb') as f:
            on_disk = tomllib.load(f)
        assert on_disk == values

    def test_writes_help_comments(self, tmp_path):
        config_file = tmp_path / '.config'
        app_settings.save_settings(app_settings.load_settings(), str(config_file))
        with open(config_file) as f:
            text = f.read()
        # The per-line explanations survive the rewrite.
        assert '# Bind address for gunicorn' in text
        assert '# Display unit for dimensions' in text
