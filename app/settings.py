"""Loads default settings from the commented .config file at the project root."""
# ColliBoy

import os
import tomllib

from app.paths import project_root


PROJECT_ROOT = project_root()
CONFIG_PATH = os.path.join(PROJECT_ROOT, '.config')

# Built-in defaults used whenever .config is missing a section or key.
DEFAULTS = {
    'webserver': {'host': 'localhost', 'port': 8181, 'workers': 1, 'open_browser': True, 'local_libraries': False},
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
        # Shrink Scene Objects previews to fit when crowded; false = old scroll/stack.
        'preview_shrink': True,
        # Persistent top-right box describing the hovered button; off by default, toggled from the status bar.
        'tip_mode': False,
        # Axis-gizmo orientation indicator at the viewport's top-left; on by default, toggled from the status bar, hidden in aesthetic mode.
        'view_cube_visible': True,
    },
    # Import separation: shift new shapes along X/Z until their bbox is at least min_gap_mm clear of every existing one.
    'import': {
        'separation_enabled': True,
        'min_gap_mm': 5.0,
    },
    # AI generation loop tuning (ai/run_agent.py). max_tokens_per_turn is the per-turn
    # completion budget; reasoning_effort goes to APIs that support it ("none" disables);
    # cleanup_enabled sweeps leftover job folders from ai/input + ai/output.
    'ai_generation': {
        'max_tokens_per_turn': 4096,
        'max_iterations': 12,
        'reasoning_effort': 'low',
        'cleanup_enabled': True,
    },
}

# Per-key help text written beside each entry when .config is generated; kept in sync with the shipped file.
COMMENTS = {
    'webserver': {
        'host': 'Bind address for gunicorn (any valid host name or IP)',
        'port': 'TCP port, an integer from 1 to 65535',
        'workers': 'Worker processes, keep at 1 - sessions live in process memory',
        'open_browser': 'Open the app in your default browser when the server starts; false disables it',
        'local_libraries': 'Mirror the three.js build + addons into js_libraries/ inside the project at startup, then serve them locally; false keeps fetching from jsdelivr and deletes any leftover mirror',
    },
    'viewport': {
        'smooth_shading': 'true: smooth/rounded normals, false: flat faceted shading (the default)',
        'lod_enabled': 'Level-of-detail switching by camera distance, on/off',
        'view_mode': 'Initial object display style: "normal", "wireframe", "transparent", or "wireframe-hybrid"',
        'camera_far': 'Camera far plane in mm; geometry beyond this distance is clipped (raise for huge models)',
    },
    'build_plate': {
        'visible': 'Show the plate furniture (grid, surface, border, crosshair)',
        'infinite': 'Auto-scale the plate to fit all loaded objects',
        'simple_plate': 'Stretch the plate instead of rebuilding it on resize (cheaper)',
        'axis_lines_visible': 'X/Y/Z axis stubs drawn at the origin',
        'default_size_mm': 'Initial/fixed plate edge length in mm',
    },
    'snap': {
        'grid_enabled': 'Grid snapping on at startup',
        'grid_size_mm': 'Snap cell size in mm, any positive number',
        'smart_enabled': 'Magnetic drag-snap: whole-mm moves, 45-degree rotations',
    },
    'ui': {
        'units': 'Display unit for dimensions: "mm", "cm", or "in"',
        'theme': '"night" (dark UI) or "day" (light UI)',
        'aesthetic_mode': 'Aura farm with dramatic lighting. Probably do not need this on by default.',
        'even_lighting': 'Flatten the lighting so all surfaces are lit evenly',
        'messages_muted': 'Suppress setting-change toast messages',
        'rotate_pivot': 'Rotation pivot: "center" (object bbox) or "origin" (world 0,0,0)',
        'preview_shrink': 'Shrink Scene Objects preview boxes to fit when there are too many; false keeps the old scroll/stack behavior',
        'tip_mode': 'Show a persistent box (top-right) describing whichever button is hovered over; off by default',
        'view_cube_visible': 'Orientation indicator (axis gizmo) in the top-left corner of the viewport; always hidden in aesthetic mode',
    },
    'import': {
        'separation_enabled': "Move newly imported shapes so their bounding box lands at least min_gap_mm away from every existing shape's bounding box; false keeps them wherever plate-snap leaves them",
        'min_gap_mm': "Minimum clear distance in mm between an imported shape's bounding box and any other shape's bounding box",
    },
    'ai_generation': {
        'max_tokens_per_turn': 'Completion budget per model turn (thinking + output); raise for models that over-think',
        'max_iterations': 'Max build/fix cycles before the job is declared failed',
        'reasoning_effort': 'Sent to the API as reasoning_effort; "none"/blank disables it. Some models honor low/medium/high',
        'cleanup_enabled': 'Sweep leftover job folders from ai/input + ai/output when AI mode opens, and delete each job\'s scratch dirs on completion; false keeps them (e.g. for debugging)',
    },
}

# Header lines written at the top of a generated .config file.
HEADER_LINES = [
    '# web-3d-builder config',
    '# By: ColliBoy',
    '# Any key left out keeps the built-in default',
]


def _format_value(value):
    """Render a Python value as a TOML literal (bool/int/float/string)."""
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        text = f'{value:.10g}'  # general format drops trailing zeros
        if '.' not in text and 'e' not in text:
            text += '.0'  # keep it a TOML float (10 -> 10.0)
        return text
    escaped = str(value).replace('\\', '\\\\').replace('"', '\\"')
    return f'"{escaped}"'


def _resolve_path(path):
    """Return the config path to use; CONFIG_PATH when no explicit one is given."""
    return CONFIG_PATH if path is None else path


def save_settings(settings, path=None):
    """Write merged settings back to .config as commented TOML.

    Known sections/keys are written in DEFAULTS order with their help comments; unknown keys are dropped."""
    path = _resolve_path(path)
    lines = list(HEADER_LINES) + ['']
    for section, values in DEFAULTS.items():
        # Render lines first so comments align to the widest "key = value" in the section.
        rendered = []
        for key in values:
            comment = COMMENTS.get(section, {}).get(key, '')
            rendered.append((f'{key} = {_format_value(settings[section][key])}', comment))
        width = max(len(line) for line, _ in rendered)
        lines.append(f'[{section}]')
        for line, comment in rendered:
            if comment:
                # Pad to 2 spaces past the widest line so the help text stays a trailing TOML comment.
                lines.append(line + ' ' * ((width + 2) - len(line)) + '# ' + comment)
            else:
                lines.append(line)
        lines.append('')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines).rstrip() + '\n')


def read_config(path=None):
    """Return the raw .config contents as a dict; an empty dict when the file is absent or unreadable."""
    try:
        with open(_resolve_path(path), 'rb') as f:
            data = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def load_settings(path=None):
    """Merge .config over DEFAULTS so every known key always has a value."""
    settings = {section: dict(values) for section, values in DEFAULTS.items()}
    data = read_config(path)
    for section, values in data.items():
        if section in settings and isinstance(values, dict):
            for key, value in values.items():
                if key in settings[section]:
                    settings[section][key] = value
    return settings
