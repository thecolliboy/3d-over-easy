"""Endpoints that serve and persist the .config file to/from the frontend."""
# ColliBoy

from flask import Blueprint, jsonify, request

from app.settings import COMMENTS, DEFAULTS, load_settings, save_settings


bp = Blueprint('settings', __name__)


@bp.route('/settings', methods=['GET'])
def get_settings():
    """Return every feature-default section of .config as JSON (webserver excluded)."""
    settings = load_settings()
    return jsonify({section: values for section, values in settings.items() if section != 'webserver'})


@bp.route('/config', methods=['GET'])
def get_config():
    """Return the full .config (every section, webserver included) as JSON."""
    return jsonify(load_settings())


@bp.route('/config/descriptions', methods=['GET'])
def get_config_descriptions():
    """Return the per-key help text (the .config comments) so the settings popup can show it under each option."""
    return jsonify(COMMENTS)


def _coerce(value, expected):
    """Coerce a submitted value to the type of its built-in default.

    Raises ValueError when the value cannot be represented as that type; the
    caller turns it into a 400 so bad input is rejected rather than persisted."""
    if expected is bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            text = value.strip().lower()
            if text in ('true', '1'):
                return True
            if text in ('false', '0'):
                return False
    elif expected is int:
        # bool is a subclass of int in Python - reject it explicitly.
        if isinstance(value, bool):
            raise ValueError('expected an integer')
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, str):
            try:
                return int(value.strip())
            except ValueError:
                raise ValueError('expected an integer') from None
    elif expected is float:
        if isinstance(value, bool):
            raise ValueError('expected a number')
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value.strip())
            except ValueError:
                raise ValueError('expected a number') from None
    elif expected is str:
        if isinstance(value, str):
            return value

    raise ValueError(f'invalid value for {expected.__name__} setting')


@bp.route('/config', methods=['POST'])
def save_config():
    """Validate and persist .config changes submitted by the settings popup.

    Accepts a JSON object of {section: {key: value}}; only known sections/keys
    are honored (unknown ones are ignored, matching how .config is read). Each
    value must be coercible to its built-in type or the request is rejected."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Expected a JSON object of settings'}), 400

    current = load_settings()
    try:
        for section, values in payload.items():
            if section not in DEFAULTS or not isinstance(values, dict):
                continue
            for key, value in values.items():
                if key not in DEFAULTS[section]:
                    continue
                current[section][key] = _coerce(value, type(DEFAULTS[section][key]))
    except ValueError as err:
        return jsonify({'error': str(err)}), 400

    save_settings(current)
    return jsonify(load_settings())
