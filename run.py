#!/usr/bin/env python3
"""Local entry point for web-3d-builder: boots a WSGI server serving the Flask app on localhost."""
# ColliBoy

import os
import sys
import webbrowser

# Put the project root on sys.path so the app package resolves from any launch directory (ColliBoy)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import create_app
from app.settings import read_config


app = create_app()


def _resolve(section, key, env_var=None, default=None):
    """Pick one webserver value: .config first, then the env var, then the built-in default."""
    value = section.get(key) if isinstance(section, dict) else None
    if value is None and env_var:
        value = os.environ.get(env_var)
    return default if value is None else value


def _browser_url(host, port):
    """The URL to open in the browser; wildcard binds are opened as localhost."""
    if host in ("0.0.0.0", "::"):
        return f"http://localhost:{port}"
    return f"http://{host}:{port}"


if __name__ == '__main__':
    webserver = read_config().get('webserver')
    host = _resolve(webserver, 'host', 'HOST', 'localhost')
    port = int(_resolve(webserver, 'port', 'PORT', 8181))
    workers = int(_resolve(webserver, 'workers', None, 1))
    open_browser = _resolve(webserver, 'open_browser', 'OPEN_BROWSER', True)
    if isinstance(open_browser, str):
        open_browser = open_browser.strip().lower() not in ('false', '0', 'no', 'off')
    else:
        open_browser = bool(open_browser)
    url = _browser_url(host, port) if open_browser else None

    if sys.platform == 'win32':
        # gunicorn relies on fork(), which Windows lacks; serve with waitress instead.
        from waitress import serve
        print(f"Starting waitress on http://{host}:{port}")
        if url:
            webbrowser.open(url)
        serve(app, host=host, port=port, threads=max(1, workers))
    else:
        if getattr(sys, 'frozen', False):
            # gunicorn loads the WSGI app by importing module 'run'; in a frozen
            # bundle there is no run.py on disk, so alias this script as 'run'.
            sys.modules['run'] = sys.modules[__name__]

        from gunicorn.app.wsgiapp import WSGIApplication

        class GunicornApp(WSGIApplication):
            """Gunicorn application that serves run:app on a fixed bind address."""

            def __init__(self, uri, bind, workers=1, browser_url=None):
                self._uri = uri
                self._bind = bind
                self._workers = workers
                self._browser_url = browser_url
                super().__init__()

            def init(self, parser, opts, args):
                super().init(parser, opts, args)
                # Pin the WSGI entry point and bind address so no CLI argument is required
                self.app_uri = self._uri
                self.cfg.set("default_proc_name", self._uri)
                self.cfg.set("bind", [self._bind])
                self.cfg.set("workers", self._workers)
                if self._browser_url:
                    # Open the app in the host browser as soon as gunicorn is ready to serve
                    self.cfg.set("when_ready", self._open_browser)

            def _open_browser(self, arbiter):
                webbrowser.open(self._browser_url)

        print(f"Starting gunicorn on http://{host}:{port}")
        GunicornApp('run:app', f'{host}:{port}', workers, browser_url=url).run()
