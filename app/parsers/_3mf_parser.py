"""3MF (3D Manufacturing Format) parser and writer.

ZIP-based open format that keeps color, materials, multiple meshes, and
build-plate layout in a single file. Covers archive detection, mesh reading,
and serialization back out to 3MF.
"""
# ColliBoy

import zipfile
import io
import xml.etree.ElementTree as ET
from typing import Optional, Dict, List
from dataclasses import dataclass, field


@dataclass
class Mesh3MF:
    """Parsed <mesh> resource: flat vertex positions, triangle indices, optional per-vertex colors.

    `transform` holds the item's positional data (row-major 4x4 from the build section) when the archive places this mesh with a transform instead of baking it in."""
    vertices: List[float] = field(default_factory=list)  # interleaved x,y,z triples
    indices: Optional[List[int]] = None  # a,b,c index triplet per triangle
    colors: Optional[List[float]] = None  # interleaved r,g,b,a quads, one per vertex
    transform: Optional[List[float]] = None  # row-major 4x4 from <item transform="..."/>


@dataclass
class ThreeMFScene:
    """All meshes from one archive."""
    meshes: List[Mesh3MF] = field(default_factory=list)


class ThreeMFParseError(Exception):
    """Failure to detect, open, or decode a 3MF archive."""
    pass


def detect_3mf(data: bytes) -> bool:
    """True when the byte prefix looks like a 3MF archive: ZIP signature plus a model XML entry."""
    # every 3MF file is a ZIP container - verify the local-file-header magic first
    if len(data) >= 4 and data[:4] == b'PK\x03\x04':
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                namelist = zf.namelist()
                # spec expects 3D/, but exporters vary - mirror _find_model_file's fallback so detection accepts anything we can parse
                for name in namelist:
                    low = name.lower()
                    if 'model' in low and (low.endswith('.xml') or low.endswith('.model')):
                        return True
        except zipfile.BadZipFile:
            pass

    return False


def parse_3mf(data: bytes) -> ThreeMFScene:
    """Decode raw archive bytes into a ThreeMFScene; raises ThreeMFParseError on malformed input."""
    if not detect_3mf(data):
        raise ThreeMFParseError("File is not a valid 3MF archive")

    scene = ThreeMFScene()

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            model_path = _find_model_file(zf)
            if not model_path:
                raise ThreeMFParseError("No model.xml found in 3MF archive")

            model_xml = zf.read(model_path)
            return _parse_3mf_xml(model_xml, scene)
    except zipfile.BadZipFile as e:
        raise ThreeMFParseError(f"Invalid ZIP archive: {e}")


def _find_model_file(zf: zipfile.ZipFile) -> Optional[str]:
    """Locate the model document inside the archive, trying known paths before falling back to a name scan."""
    namelist = zf.namelist()

    # paths seen in the wild; exporters disagree on casing and layout
    candidates = [
        '3D/3DModel.model',
        '3d/3DModel.model',
        'model.model',
        '3D/model.model',
        '3d/model.model',
    ]

    for candidate in candidates:
        if candidate in namelist:
            return candidate

    # last resort: accept anything that looks like a model document (ColliBoy)
    for name in namelist:
        if name.endswith('.model') or (name.endswith('.xml') and 'model' in name.lower()):
            return name

    return None


def _parse_3mf_xml(xml_data: bytes, scene: ThreeMFScene) -> ThreeMFScene:
    """Decode the model document into scene meshes."""
    try:
        root = ET.fromstring(xml_data)
    except ET.ParseError as e:
        raise ThreeMFParseError(f"Invalid XML in 3MF file: {e}")

    # <resources> holds every mesh definition in the file, keyed by object id where present
    entries = []
    resources = _find_element(root, 'resources')
    if resources is not None:
        entries = _parse_meshes(resources)

    # <build> items carry each object's positional data; map item transforms onto their meshes
    item_transforms = {}
    build = _find_element(root, 'build')
    if build is not None:
        for item in _find_all_elements(build, 'item'):
            obj_id = item.get('objectid') or item.get('objectId')
            t_attr = item.get('transform')
            if obj_id and t_attr:
                try:
                    values = [float(v) for v in t_attr.split()]
                except ValueError:
                    continue
                if len(values) == 16:
                    item_transforms[obj_id] = values

    for object_id, mesh in entries:
        if object_id and object_id in item_transforms:
            mesh.transform = item_transforms[object_id]
        scene.meshes.append(mesh)

    return scene


def _find_element(parent: ET.Element, tag: str) -> Optional[ET.Element]:
    """First child whose local tag name matches, namespace prefixes ignored."""
    for child in parent:
        # ElementTree expands namespaces to {uri}name - compare on the local part
        local_name = child.tag.split('}')[-1] if '}' in child.tag else child.tag
        if local_name == tag:
            return child
    return None


def _find_all_elements(parent: ET.Element, tag: str) -> List[ET.Element]:
    """Every child whose local tag name matches, namespace prefixes ignored."""
    results = []
    for child in parent:
        local_name = child.tag.split('}')[-1] if '}' in child.tag else child.tag
        if local_name == tag:
            results.append(child)
    return results


def _parse_meshes(resources: ET.Element) -> List[tuple]:
    """Extract each <mesh> under resources as (object_id, Mesh3MF) pairs.

    Spec files wrap geometry in <object type="model"><mesh>; some exporters emit
    bare <mesh> entries instead, which come back with a None id."""
    entries = []
    for child in resources:
        local_name = child.tag.split('}')[-1] if '}' in child.tag else child.tag
        if local_name == 'object':
            object_id = child.get('id')
            for mesh_elem in _find_all_elements(child, 'mesh'):
                mesh_obj = _parse_mesh_element(mesh_elem)
                if mesh_obj is not None:
                    entries.append((object_id, mesh_obj))
        elif local_name == 'mesh':
            mesh_obj = _parse_mesh_element(child)
            if mesh_obj is not None:
                entries.append((None, mesh_obj))

    return entries


def _parse_mesh_element(mesh_elem: ET.Element) -> Optional[Mesh3MF]:
    """Decode one <mesh> element into a Mesh3MF with vertices, triangles, and colors."""
    mesh_obj = Mesh3MF()

    # some exporters nest the geometry in an inner <mesh>; spec files keep it direct
    mesh_content = _find_element(mesh_elem, 'mesh') or mesh_elem

    vertices = []
    indices = []
    colors = []

    verts_elem = _find_element(mesh_content, 'vertices')
    if verts_elem:
        # spec uses <vertex x y z/>; older in-house exports used the short <v> tag
        for vertex_elem in (_find_all_elements(verts_elem, 'vertex') or _find_all_elements(verts_elem, 'v')):
            x = float(vertex_elem.get('x', 0))
            y = float(vertex_elem.get('y', 0))
            z = float(vertex_elem.get('z', 0))
            vertices.extend([x, y, z])

    # spec colors live in a <colors><color id=...><c r g b a/></color></colors> block;
    # legacy exports nested one <c> under each vertex instead
    color_block = _find_element(mesh_content, 'colors')
    if color_block:
        for color_set in _find_all_elements(color_block, 'color'):
            for c_elem in _find_all_elements(color_set, 'c'):
                r = float(c_elem.get('r', 1.0))
                g = float(c_elem.get('g', 1.0))
                b = float(c_elem.get('b', 1.0))
                a = float(c_elem.get('a', 1.0))
                colors.extend([r, g, b, a])

    if not colors and verts_elem is not None:
        # legacy per-vertex colors, kept for older exports
            for vertex_elem in _find_all_elements(verts_elem, 'v'):
                c_elem = _find_element(vertex_elem, 'c')
                if c_elem is not None:
                    r = float(c_elem.get('r', 1.0))
                    g = float(c_elem.get('g', 1.0))
                    b = float(c_elem.get('b', 1.0))
                    a = float(c_elem.get('a', 1.0))
                    colors.extend([r, g, b, a])

    # spec uses <triangles><triangle v1 v2 v3/>; legacy exports used <tris><tri a b c/>
    tris_elem = _find_element(mesh_content, 'triangles') or _find_element(mesh_content, 'tris')
    if tris_elem:
        for tri in tris_elem:
            local_name = tri.tag.split('}')[-1] if '}' in tri.tag else tri.tag
            if local_name == 'triangle':
                a = int(tri.get('v1', 0))
                b = int(tri.get('v2', 0))
                c = int(tri.get('v3', 0))
            elif local_name in ('tri', 't'):
                a = int(tri.get('a', 0))
                b = int(tri.get('b', 0))
                c = int(tri.get('c', 0))
            else:
                continue
            indices.extend([a, b, c])

    if vertices and indices:
        mesh_obj.vertices = vertices
        mesh_obj.indices = indices or None
        if colors:
            mesh_obj.colors = colors
        return mesh_obj

    return None


def apply_item_transform(vertices: List[float], matrix: List[float]) -> List[float]:
    """Move local-space vertices through a row-major 4x4 item transform.

    Used on import so meshes placed with an <item transform> land at their
    archive positions once merged into the app's flat vertex pools."""
    out = []
    for i in range(0, len(vertices), 3):
        x, y, z = vertices[i], vertices[i + 1], vertices[i + 2]
        out.extend([
            matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
            matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
            matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11],
        ])
    return out


def _format_item_transform(transform) -> Optional[str]:
    """Format a mesh's positional data as an <item transform="..."/> value.

    Input is the 16-value column-major matrix the frontend ships (three.js
    Matrix4.elements order); the spec stores it row-major, so the values are
    transposed on the way out. Returns None when no valid transform is present.
    """
    if not isinstance(transform, (list, tuple)) or len(transform) != 16:
        return None
    try:
        flat = [float(v) for v in transform]
    except (TypeError, ValueError):
        return None

    # column-major index c*4+r holds M[r][c]; the spec wants rows concatenated
    row_major = [flat[(i % 4) * 4 + (i // 4)] for i in range(16)]
    return ' '.join(repr(v) for v in row_major)


def write_3mf(
    meshes: List[Dict]
) -> bytes:
    """Serialize meshes back into a valid 3MF ZIP archive.

    Each mesh dict needs 'vertices' (flat or per-vertex tuples); 'indices',
    'colors', and 'transform' are optional. Every mesh gets its own <object>
    resource plus build item - models are never merged; when one carries a
    16-value transform, the item keeps it as positional data instead of baking
    positions into vertices. Output follows the spec's content-type, rels,
    resources, and build layout.
    """
    resources_xml_parts = []
    items_xml_parts = []

    for idx, mesh in enumerate(meshes):
        object_id = str(idx + 1)

        vertices = mesh['vertices']
        if isinstance(vertices, (list, tuple)) and len(vertices) > 0 and isinstance(vertices[0], (tuple, list)):
            vert_tuples = vertices
        else:
            flat = vertices
            vert_tuples = [(flat[i], flat[i + 1], flat[i + 2]) for i in range(0, len(flat), 3)]

        indices = mesh.get('indices') or []
        colors = mesh.get('colors')

        # emit vertex entries at micro-meter precision
        verts_xml = '<vertices>'
        for v in vert_tuples:
            verts_xml += f'<vertex x="{v[0]:.6f}" y="{v[1]:.6f}" z="{v[2]:.6f}"/>'
        verts_xml += '</vertices>'

        # normalize colors into RGBA quads; RGB input gets full opacity
        color_data = None
        if colors and isinstance(colors, list) and len(colors) > 0:
            if len(colors) % 4 == 0:
                color_data = [(colors[i], colors[i + 1], colors[i + 2], colors[i + 3]) for i in range(0, len(colors), 4)]
            else:
                color_data = [(colors[i], colors[i + 1], colors[i + 2], 1.0) for i in range(0, len(colors), 3)]

        tris_xml = '<triangles' + (' colors="c1"' if color_data else '') + '>'
        if indices:
            for i in range(0, len(indices), 3):
                a, b, c = indices[i], indices[i + 1], indices[i + 2]
                tris_xml += f'<triangle v1="{a}" v2="{b}" v3="{c}"/>'
        else:
            # indexless meshes fall back to sequential vertex triplets
            for i in range(0, len(vert_tuples), 3):
                tris_xml += f'<triangle v1="{i}" v2="{i+1}" v3="{i+2}"/>'
        tris_xml += '</triangles>'

        mesh_xml = '<mesh>'
        mesh_xml += verts_xml
        if color_data:
            colors_xml = '<colors><color id="c1">'
            for r, g, b_val, a in color_data:
                colors_xml += f'<c r="{r:.4f}" g="{g:.4f}" b="{b_val:.4f}" a="{a:.4f}"/>'
            colors_xml += '</color></colors>'
            mesh_xml += colors_xml
        mesh_xml += tris_xml
        mesh_xml += '</mesh>'

        # spec layout: every mesh lives inside an <object> resource that build items reference by id
        resources_xml_parts.append(f'<object id="{object_id}" type="model">{mesh_xml}</object>')

        # positional data rides on the item, keeping each model separate in the archive
        transform_attr = _format_item_transform(mesh.get('transform'))
        if transform_attr:
            items_xml_parts.append(f'<item objectid="{object_id}" transform="{transform_attr}"/>')
        else:
            items_xml_parts.append(f'<item objectid="{object_id}"/>')

    # assemble the OPC package: content types, root rels, and the model document
    content_type = '[Content_Types].xml'
    content_type_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>'''

    rels = '_rels/.rels'
    rels_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/package/2006/relationships/officeDocument" Target="3D/3DModel.model"/>
</Relationships>'''

    model_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter">
    <resources>
        {"".join(resources_xml_parts)}
    </resources>
    <build builditemcount="{len(meshes)}">
        {"".join(items_xml_parts)}
    </build>
</model>'''

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(content_type, content_type_xml)
        zf.writestr(rels, rels_xml)
        zf.writestr('3D/3DModel.model', model_xml)

    return zip_buffer.getvalue()
