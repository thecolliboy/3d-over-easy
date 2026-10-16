"""Unit tests for the local three.js library mirror (app/libraries.py)."""
# ColliBoy

import os

from app import libraries


def test_manifest_paths_are_unique():
    rels = [rel for rel, _ in libraries.LIB_MANIFEST]
    assert len(rels) == len(set(rels))


def test_manifest_urls_use_pinned_version():
    for _, url in libraries.LIB_MANIFEST:
        assert url.startswith(libraries.CDN_BASE)


def test_mirror_root_lives_inside_the_project():
    from app.paths import project_root
    root = libraries.libs_root()
    assert os.path.dirname(root) == project_root()
    assert os.path.basename(root) == 'js_libraries'


def test_remove_local_deletes_existing_folder(tmp_path, monkeypatch):
    folder = tmp_path / 'js_libraries'
    (folder / f'three-{libraries.THREE_VERSION}' / 'build').mkdir(parents=True)
    (folder / f'three-{libraries.THREE_VERSION}' / 'build' / 'three.module.js').write_bytes(b'x')

    monkeypatch.setattr(libraries, 'libs_root', lambda: str(folder))
    assert libraries.remove_local() is True
    assert not folder.exists()


def test_remove_local_is_a_noop_when_folder_is_absent(tmp_path, monkeypatch):
    monkeypatch.setattr(libraries, 'libs_root', lambda: str(tmp_path / 'js_libraries'))
    assert libraries.remove_local() is False


def test_local_ready_is_false_when_files_are_missing(tmp_path, monkeypatch):
    def fake_local_path(rel):
        return str(tmp_path / rel)

    monkeypatch.setattr(libraries, 'local_path', fake_local_path)
    assert libraries.local_ready() is False


def test_three_base_url_switches_with_mirror_state(monkeypatch):
    monkeypatch.setattr(libraries, 'use_local', lambda: True)
    assert libraries.three_base_url() == f'/lib/three-{libraries.THREE_VERSION}/'

    monkeypatch.setattr(libraries, 'use_local', lambda: False)
    assert libraries.three_base_url() == libraries.CDN_BASE


def test_ensure_downloaded_skips_files_that_already_exist(tmp_path, monkeypatch):
    def fake_local_path(rel):
        return str(tmp_path / rel)

    monkeypatch.setattr(libraries, 'local_path', fake_local_path)

    urls_fetched = []

    def fake_download(url, dest):
        urls_fetched.append(url)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, 'wb') as f:
            f.write(b'x')

    monkeypatch.setattr(libraries, '_download', fake_download)

    assert libraries.ensure_downloaded(verbose=False) is True
    assert len(urls_fetched) == len(libraries.LIB_MANIFEST)

    # Second pass: all files exist, so no fetches happen.
    urls_fetched.clear()
    assert libraries.ensure_downloaded(verbose=False) is True
    assert urls_fetched == []
