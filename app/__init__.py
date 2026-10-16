"""Flask application package: app factory, config wiring, and route registration."""
# ColliBoy

import os
from flask import Flask, render_template, request, send_from_directory
from flask_cors import CORS

from app.config import config_by_name


def create_app(config_name=None, static_folder=None, template_folder=None):
    """Build a configured Flask application instance."""
    if config_name is None:
        config_name = os.environ.get('FLASK_CONFIG', 'default')

    from app.paths import project_root
    root = project_root()
    kwargs = {
        'static_folder': static_folder or os.path.join(root, 'static'),
        'static_url_path': '/static',
        'template_folder': template_folder or os.path.join(root, 'templates'),
    }

    app = Flask(__name__, **kwargs)
    app.config.from_object(config_by_name[config_name])

    # Ensure upload folder exists
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

    # Enable CORS for all origins on /api/*
    CORS(app, resources={r"/api/*": {"origins": "*"}})

    # Mount the route blueprints under their URL prefixes
    from app.routes import import_export, csg, geometry, primitives, history, objects, operations, ai, settings
    app.register_blueprint(import_export, url_prefix='/api')
    app.register_blueprint(csg, url_prefix='/api/csg')
    app.register_blueprint(geometry, url_prefix='/api/geometry')
    app.register_blueprint(primitives, url_prefix='/api/primitives')
    app.register_blueprint(history, url_prefix='/api/history')
    app.register_blueprint(objects, url_prefix='/api/objects')
    app.register_blueprint(operations)
    app.register_blueprint(ai, url_prefix='/api/ai')
    app.register_blueprint(settings, url_prefix='/api')

    # JSON errors for /api/*, HTML pages otherwise
    @app.errorhandler(404)
    def not_found(error):
        if request.path.startswith('/api/'):
            return {'error': 'Not found'}, 404
        return render_template('error.html', code=404, message='Page not found'), 404

    @app.errorhandler(500)
    def internal_error(error):
        if request.path.startswith('/api/'):
            return {'error': 'Internal server error'}, 500
        return render_template('error.html', code=500, message='Server error'), 500

    @app.errorhandler(413)
    def too_large(error):
        if request.path.startswith('/api/'):
            return {'error': 'File too large. Maximum size is 50MB.'}, 413
        return render_template('error.html', code=413, message='File too large'), 413

    # Serve local three.js libs (webserver.local_libraries) at /lib/
    from app.libraries import libs_root
    @app.route('/lib/<path:name>')
    def lib_file(name):
        return send_from_directory(libs_root(), name)

    # Serve editor landing page at /; import map selects local vs CDN three.js
    from app.libraries import three_base_url
    @app.route('/')
    def index():
        return render_template('index.html', three_base_url=three_base_url())

    return app
