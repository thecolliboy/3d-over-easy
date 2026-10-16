"""Local mirror of the three.js build and addon modules the frontend imports.

When [webserver] local_libraries is enabled in .config, run.py downloads every
file in LIB_MANIFEST into js_libraries/ inside the project so the editor works
offline; otherwise templates import from jsdelivr as before and any leftover
mirror is deleted at startup.
"""
# ColliBoy

import os
import shutil
import ssl
import tempfile
import urllib.request

from app.paths import project_root

# Pinned three.js version - single source of truth for both the CDN base and
# the local mirror folder name (bump it here when upgrading).
THREE_VERSION = '0.164.1'
CDN_BASE = f'https://cdn.jsdelivr.net/npm/three@{THREE_VERSION}/'

# Every file the browser fetches from the CDN, as (path under the mirror root, url) pairs.
# The addons are the full import closure of static/js; each imports only 'three' plus the others listed here.
LIB_MANIFEST = [
    ('build/three.module.js', f'{CDN_BASE}build/three.module.js'),
    ('examples/jsm/controls/OrbitControls.js', f'{CDN_BASE}examples/jsm/controls/OrbitControls.js'),
    ('examples/jsm/controls/TransformControls.js', f'{CDN_BASE}examples/jsm/controls/TransformControls.js'),
    ('examples/jsm/utils/BufferGeometryUtils.js', f'{CDN_BASE}examples/jsm/utils/BufferGeometryUtils.js'),
    ('examples/jsm/lines/Line2.js', f'{CDN_BASE}examples/jsm/lines/Line2.js'),
    ('examples/jsm/lines/LineGeometry.js', f'{CDN_BASE}examples/jsm/lines/LineGeometry.js'),
    ('examples/jsm/lines/LineMaterial.js', f'{CDN_BASE}examples/jsm/lines/LineMaterial.js'),
    ('examples/jsm/lines/LineSegments2.js', f'{CDN_BASE}examples/jsm/lines/LineSegments2.js'),
    ('examples/jsm/lines/LineSegmentsGeometry.js', f'{CDN_BASE}examples/jsm/lines/LineSegmentsGeometry.js'),
]


def libs_root():
    """Folder holding the downloaded libraries: <project>/js_libraries."""
    return os.path.join(project_root(), 'js_libraries')


def local_path(rel):
    """Absolute path of one mirrored file, e.g. .../web-3d-builder/js_libraries/three-0.164.1/build/three.module.js."""
    return os.path.join(libs_root(), f'three-{THREE_VERSION}', rel)


def local_ready():
    """True when every manifest file exists on disk (no network access)."""
    return all(os.path.isfile(local_path(rel)) for rel, _ in LIB_MANIFEST)


def use_local():
    """True when .config enables the mirror and it is complete."""
    from app.settings import load_settings
    enabled = bool(load_settings().get('webserver', {}).get('local_libraries'))
    return enabled and local_ready()


def three_base_url():
    """Base URL for the page's import map: /lib/ when mirrored, else the CDN."""
    if use_local():
        return f'/lib/three-{THREE_VERSION}/'
    return CDN_BASE


def ensure_downloaded(verbose=True):
    """Download any missing library files; True when the full set is present afterwards.

    Already-downloaded files are skipped, so repeated starts are instant and a
    failed run resumes where it stopped.
    """
    for rel, url in LIB_MANIFEST:
        dest = local_path(rel)
        if os.path.isfile(dest):
            continue
        try:
            _download(url, dest)
        except OSError as exc:
            print(f'Library download failed ({url}): {exc}')
            continue
        if verbose:
            print(f'Downloaded three.js library file: {dest}')
    return local_ready()


def remove_local():
    """Delete the mirrored js_libraries/ folder; True when there was something to delete.

    Called at startup when [webserver] local_libraries is disabled, so a mirror
    left behind by an earlier enabled run does not linger in the project.
    """
    root = libs_root()
    if not os.path.isdir(root):
        return False
    shutil.rmtree(root)
    return True


def _ssl_context():
    """SSL context for downloads.

Uses the system CAs by default; when Python's own CA bundle is missing (common on macOS python.org installs and frozen builds), fall back to certifi's bundle if available.
    """
    paths = ssl.get_default_verify_paths()
    if paths.cafile and os.path.isfile(paths.cafile):
        return None  # default context is fine
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return None


def _download(url, dest):
    """Fetch url into dest atomically (temp file + rename) so a half-written
    file can never be mistaken for the real library."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={'User-Agent': 'web-3d-builder'})
    with urllib.request.urlopen(req, timeout=60, context=_ssl_context()) as resp:
        data = resp.read()
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), suffix='.part')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        os.replace(tmp, dest)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
