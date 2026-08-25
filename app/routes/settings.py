"""Endpoint that serves the .config feature defaults to the frontend at startup."""
# ColliBoy

from flask import Blueprint, jsonify

from app.settings import load_settings


bp = Blueprint('settings', __name__)


@bp.route('/settings', methods=['GET'])
def get_settings():
    """Return every feature-default section of .config as JSON (webserver excluded)."""
    settings = load_settings()
    return jsonify({section: values for section, values in settings.items() if section != 'webserver'})
