"""Loads default settings from the commented .config file at the project root."""
# ColliBoy

import os
import tomllib

from app.paths import project_root


PROJECT_ROOT = project_root()
CONFIG_PATH = os.path.join(PROJECT_ROOT, '.config')

# Built-in defaults used whenever .config is missing a section or key.
DEFAULTS = {
    'webserver': {'host': 'localhost', 'port': 8181, 'workers': 1, 'open_browser': True},
    'viewport': {'smooth_shading': False, 'lod_enabled': True, 'view_mode': 'normal', 'camera_far': 100000},
    'build_plate': {'visible': True, 'infinite': True, 'simple_plate': False, 'axis_lines_visible': True, 'default_size_mm': 10.0},
    'snap': {'grid_enabled': False, 'grid_size_mm': 1.0, 'smart_enabled': True},
    'ui': {
        'units': 'mm',
        'theme': 'night',
        'aesthetic_mode': False,
        'even_lighting': False,
        'messages_muted': False,
        'rotate_pivot': 'center',
    },
    # AI generation loop tuning (ai/run_agent.py). max_tokens_per_turn is the per-turn
    # completion budget (thinking + output); raise it for models that over-think.
    # reasoning_effort is passed to OpenAI-compatible APIs that support it; "none" disables it.
    # cleanup_enabled sweeps residual job folders from ai/input + ai/output when AI mode
    # opens and deletes each job's scratch dirs on completion; false keeps them (debugging).
    'ai_generation': {
        'max_tokens_per_turn': 4096,
        'max_iterations': 12,
        'reasoning_effort': 'low',
        'cleanup_enabled': True,
    },
}


def read_config(path=CONFIG_PATH):
    """Return the raw .config contents as a dict; an empty dict when the file is absent or unreadable."""
    try:
        with open(path, 'rb') as f:
            data = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def load_settings(path=CONFIG_PATH):
    """Merge .config over DEFAULTS so every known key always has a value."""
    settings = {section: dict(values) for section, values in DEFAULTS.items()}
    data = read_config(path)
    for section, values in data.items():
        if section in settings and isinstance(values, dict):
            for key, value in values.items():
                if key in settings[section]:
                    settings[section][key] = value
    return settings
