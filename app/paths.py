"""Resolves the project root in both dev mode and when frozen (PyInstaller)."""
# ColliBoy

import os
import sys


def project_root():
    """The directory that holds static/, templates/, .config, and ai/.

    In a normal run this is the folder above app/; when frozen it is the
    folder containing the executable, where the build places those assets.
    """
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
