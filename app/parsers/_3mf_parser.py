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
    """Parsed <mesh> resource: flat vertex positions, triangle indices, optional per-vertex colors."""
    vertices: List[float] = field(default_factory=list)  # interleaved x,y,z triples
    indices: Optional[List[int]] = None  # a,b,c index triplet per triangle
    colors: Optional[List[float]] = None  # interleaved r,g,b,a quads, one per vertex


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
                # spec puts the model under 3D/, but exporters vary - accept any *model* xml/model part,
                # mirroring _find_model_file's own fallback so detection never rejects what it can parse
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

    # <resources> holds every mesh definition in the file
    resources = _find_element(root, 'resources')
    if resources is not None:
        scene.meshes.extend(_parse_meshes(resources))

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


def _parse_meshes(resources: ET.Element) -> List[Mesh3MF]:
    """Extract each <mesh> under resources into a Mesh3MF with vertices, triangles, and colors."""
    meshes = []
    mesh_elements = _find_all_elements(resources, 'mesh')

    for mesh_elem in mesh_elements:
        mesh_obj = Mesh3MF()

        # some exporters nest the geometry in an inner <mesh>; spec files keep it direct
        mesh_content = _find_element(mesh_elem, 'mesh') or mesh_elem

        vertices = []
        indices = []
        colors = []

        # flag color support when any <tris> block declares a color set
        has_color = False
        for child in mesh_content:
            local_name = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if local_name == 'tris' and child.get('colors'):
                has_color = True
                break

        verts_elem = _find_element(mesh_content, 'vertices')
        if verts_elem:
            for vertex_elem in _find_all_elements(verts_elem, 'v'):
                x = float(vertex_elem.get('x', 0))
                y = float(vertex_elem.get('y', 0))
                z = float(vertex_elem.get('z', 0))
                vertices.extend([x, y, z])

                # some exporters nest an explicit color entry under each vertex
                c_elem = _find_element(vertex_elem, 'c')
                if c_elem:
                    r = float(c_elem.get('r', 1.0))
                    g = float(c_elem.get('g', 1.0))
                    b = float(c_elem.get('b', 1.0))
                    a = float(c_elem.get('a', 1.0))
                    colors.extend([r, g, b, a])

        tris_elem = _find_element(mesh_content, 'tris')
        if tris_elem:
            for tri in tris_elem:
                a = int(tri.get('a', 0))
                b = int(tri.get('b', 0))
                c = int(tri.get('c', 0))
                indices.extend([a, b, c])

        if vertices:
            mesh_obj.vertices = vertices
            mesh_obj.indices = indices or None
            if has_color and colors:
                mesh_obj.colors = colors

            meshes.append(mesh_obj)

    return meshes


def write_3mf(
    meshes: List[Dict]
) -> bytes:
    """Serialize meshes back into a valid 3MF ZIP archive.

    Each mesh dict needs 'vertices' (flat or per-vertex tuples); 'indices' and
    'colors' are optional. Output follows the spec's content-type, relationship,
    resources, and build layout structure.
    """
    resources_xml_parts = []

    for idx, mesh in enumerate(meshes):
        mesh_id = str(idx + 1)

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
            verts_xml += f'<v x="{v[0]:.6f}" y="{v[1]:.6f}" z="{v[2]:.6f}"/>'
        verts_xml += '</vertices>'

        tris_xml = '<tris>'
        if indices:
            for i in range(0, len(indices), 3):
                a, b, c = indices[i], indices[i + 1], indices[i + 2]
                tris_xml += f'<tri a="{a}" b="{b}" c="{c}"/>'
        else:
            # indexless meshes fall back to sequential vertex triplets
            for i in range(len(vert_tuples)):
                tris_xml += f'<tri a="{i}" b="{i+1}" c="{i+2}"/>'
        tris_xml += '</tris>'

        # normalize colors into RGBA quads; RGB input gets full opacity
        color_data = None
        if colors and isinstance(colors, list) and len(colors) > 0:
            if len(colors) % 4 == 0:
                color_data = [(colors[i], colors[i + 1], colors[i + 2], colors[i + 3]) for i in range(0, len(colors), 4)]
            else:
                color_data = [(colors[i], colors[i + 1], colors[i + 2], 1.0) for i in range(0, len(colors), 3)]

        mesh_xml = f'<mesh id="{mesh_id}">'
        mesh_xml += verts_xml
        if color_data:
            tris_with_colors = '<tris colors="c1">'
            for i in range(0, len(indices), 3):
                a, b, c = indices[i], indices[i + 1], indices[i + 2]
                tris_with_colors += f'<tri a="{a}" b="{b}" c="{c}"/>'
            tris_with_colors += '</tris>'

            colors_xml = '<colors><color id="c1">'
            for r, g, b_val, a in color_data:
                colors_xml += f'<c r="{r:.4f}" g="{g:.4f}" b="{b_val:.4f}" a="{a:.4f}"/>'
            colors_xml += '</color></colors>'

            mesh_xml += colors_xml
            mesh_xml += tris_with_colors
        else:
            mesh_xml += tris_xml
        mesh_xml += '</mesh>'

        resources_xml_parts.append(mesh_xml)

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
    <build builditemcount="{len(meshes)}" xmlns:design="http://schemas.microsoft.com/3dmanufacturing/design/2016/03">
        {"".join(f'<item partnumber="{idx + 1}" />' for idx in range(len(meshes)))}
    </build>
</model>'''

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(content_type, content_type_xml)
        zf.writestr(rels, rels_xml)
        zf.writestr('3D/3DModel.model', model_xml)

    return zip_buffer.getvalue()
