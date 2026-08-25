"""Route blueprint registry for the web 3D builder API.

Re-exports each route module's Blueprint under a short name so the app
factory can register every endpoint group from a single import point.
"""
# ColliBoy

from app.routes.import_export import bp as import_export
from app.routes.csg import bp as csg
from app.routes.geometry import bp as geometry
from app.routes.primitives import bp as primitives
from app.routes.history import bp as history
from app.routes.objects import bp as objects
from app.routes.operations import bp as operations
from app.routes.ai import bp as ai
from app.routes.settings import bp as settings
