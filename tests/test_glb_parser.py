"""Unit tests for the GLB/GLTF parser (glTF Binary container).

Covers format detection, decode round-trips against synthetic GLBs built
in-file, and failure modes.
"""
# ColliBoy

import struct
import json
import pytest

from app.parsers.glb_gltf_parser import (
    detect_gltf_format,
    parse_glb,
    GlTfParseError,
)


# format detection coverage

def test_detect_glb():
    """The glTF magic prefix is recognized as a GLB container."""
    data = b'glTF' + b'\x00' * 12
    assert detect_gltf_format(data) == 'glb'


def test_detect_glb_from_magic():
    """Detection succeeds from the bare magic plus version bytes alone."""
    data = b'glTF\x02\x00\x00\x00\x00\x00\x00\x00'
    assert detect_gltf_format(data) == 'glb'


def test_detect_invalid():
    """Unrelated payloads are rejected and yield None."""
    data = b'STL binary file header here'
    assert detect_gltf_format(data) is None


# glb container building

def _make_minimal_glb(num_vertices: int = 3, num_indices: int = 3) -> bytes:
    """Assemble a minimal single-mesh GLB with one position accessor and an index buffer."""
    json_content = {
        'asset': {'version': '2.0', 'generator': 'test'},
        'buffers': [{'byteLength': num_indices * 4}],
        'bufferViews': [
            {
                'buffer': 0,
                'byteOffset': 0,
                'byteLength': num_vertices * 12,  # three float32 components per vertex
                'target': 34962,  # vertex attribute buffer target
            },
            {
                'buffer': 0,
                'byteOffset': num_vertices * 12,
                'byteLength': num_indices * 4,
                'target': 34963,  # index buffer target
            }
        ],
        'accessors': [
            {
                'bufferView': 0,
                'componentType': 5126,  # float32 component type
                'count': num_vertices,
                'type': 'VEC3',
                'max': [1.0, 1.0, 1.0],
                'min': [0.0, 0.0, 0.0],
            },
            {
                'bufferView': 1,
                'componentType': 5123,  # uint16 component type
                'count': num_indices,
                'type': 'SCALAR',
            }
        ],
        'meshes': [{
            'primitives': [{
                'attributes': {'POSITION': 0},
                'indices': 1,
                'mode': 4,  # triangle primitive mode
            }]
        }],
    }

    json_str = json.dumps(json_content)
    json_bytes = json_str.encode('utf-8')
    json_padding = (4 - len(json_bytes) % 4) % 4  # pad to a four-byte boundary so chunk offsets stay aligned (ColliBoy)
    json_bytes += b' ' * json_padding

    # binary chunk payload: packed positions followed by index values
    bin_data = bytearray()
    for i in range(num_vertices):
        bin_data.extend(struct.pack('<fff', float(i), 0.0, 0.0))

    for i in range(num_indices):
        bin_data.extend(struct.pack('<H', i))

    json_len = len(json_bytes)
    bin_len = len(bin_data)
    total_len = 12 + 8 + json_len + 8 + bin_len

    # container header: magic, format version, declared total length
    header = struct.pack('<I', 0x46546C67)  # little-endian bytes of b'glTF'
    header += struct.pack('<I', 2)
    header += struct.pack('<I', total_len)

    # JSON chunk: length, type marker, padded document
    json_chunk = struct.pack('<I', json_len)
    json_chunk += struct.pack('<I', 0x4E4F534A)  # little-endian bytes of b'JSON'
    json_chunk += json_bytes

    # BIN chunk: length, type marker, binary payload
    bin_chunk = struct.pack('<I', bin_len)
    bin_chunk += struct.pack('<I', 0x004E4942)  # little-endian bytes of b'BIN\x00'
    bin_chunk += bytes(bin_data)

    return header + json_chunk + bin_chunk


def test_parse_minimal_glb():
    """A well-formed minimal GLB round-trips through the parser without error."""
    scene = parse_glb(_make_minimal_glb(3, 3))
    assert len(scene.meshes) == 1
    mesh = scene.meshes[0]
    assert len(mesh.vertices) == 9        # three float32 components per vertex
    assert mesh.indices == [0, 1, 2]


def test_parse_glb_multiple_triangles():
    """Larger vertex and index counts still decode to full-sized arrays."""
    num_tris = 10
    mesh = parse_glb(_make_minimal_glb(num_tris * 3, num_tris * 3)).meshes[0]
    assert len(mesh.vertices) == num_tris * 9   # three vertices per triangle, float32 xyz
    assert len(mesh.indices) == num_tris * 3


def test_parse_glb_with_indices():
    """Index accessors are laid out after the position accessor."""
    mesh = parse_glb(_make_minimal_glb(4, 6)).meshes[0]
    # four vertices of float32 xyz, then six sequential index values
    assert len(mesh.vertices) == 12
    assert mesh.indices == [0, 1, 2, 3, 4, 5]


# failure modes

def test_parse_invalid_magic():
    """Payloads without the glTF magic are rejected."""
    with pytest.raises(GlTfParseError):
        parse_glb(b'not a glb file at all')


def test_parse_truncated_glb():
    """A header promising more bytes than present raises an error."""
    # valid header whose declared length exceeds the actual payload
    data = struct.pack('<I', 0x46546C67)  # glTF magic
    data += struct.pack('<I', 2)           # format version 2
    data += struct.pack('<I', 100)         # declared length beyond what follows

    with pytest.raises(GlTfParseError):
        parse_glb(data[:20])  # cut off mid-chunk


def test_parse_unsupported_version():
    """glTF version 1 payloads are outside the supported range."""
    data = struct.pack('<I', 0x46546C67)  # glTF magic
    data += struct.pack('<I', 1)           # legacy version, not supported
    data += struct.pack('<I', 12)          # declared length

    with pytest.raises(GlTfParseError, match="version"):
        parse_glb(data)


def test_parse_missing_json_chunk():
    """A container whose JSON chunk is cut short fails to parse."""
    # header plus a truncated JSON chunk, no BIN data at all
    json_bytes = b'{}'
    bin_len = 0
    total_len = 12 + 8 + len(json_bytes) + 8 + bin_len

    data = struct.pack('<I', 0x46546C67)  # glTF magic
    data += struct.pack('<I', 2)           # format version 2
    data += struct.pack('<I', total_len)

    # keep only five bytes of the JSON chunk so parsing runs out of data
    json_chunk = struct.pack('<I', len(json_bytes))
    json_chunk += struct.pack('<I', 0x4E4F534A)
    json_chunk += json_bytes

    data += json_chunk[:5]  # truncate the chunk mid-stream

    with pytest.raises(GlTfParseError):
        parse_glb(data)


def test_parse_file_too_small():
    """Payloads shorter than the twelve-byte header are rejected."""
    with pytest.raises(GlTfParseError, match="too small"):
        parse_glb(b'glTF')
