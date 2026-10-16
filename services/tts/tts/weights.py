"""Reads safetensors files with numpy alone (bf16 is widened to float32)."""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

_DTYPES = {"F32": np.float32, "F16": np.float16, "I64": np.int64, "I32": np.int32, "U8": np.uint8}
MAX_HEADER = 64 << 20


def read_safetensors(path: str | Path) -> dict[str, np.ndarray]:
    raw = Path(path).read_bytes()
    if len(raw) < 8:
        raise ValueError(f"{path}: not a safetensors file")
    (n,) = struct.unpack("<Q", raw[:8])
    if n > MAX_HEADER or 8 + n > len(raw):
        raise ValueError(f"{path}: bad header length")
    header = json.loads(raw[8 : 8 + n])
    header.pop("__metadata__", None)
    base = 8 + n
    out = {}
    for name, info in header.items():
        start, end = info["data_offsets"]
        buf = raw[base + start : base + end]
        shape = tuple(info["shape"])
        if info["dtype"] == "BF16":
            bits = np.frombuffer(buf, dtype="<u2").astype(np.uint32) << 16
            arr = bits.view(np.float32)
        elif info["dtype"] in _DTYPES:
            arr = np.frombuffer(buf, dtype=np.dtype(_DTYPES[info["dtype"]]).newbyteorder("<"))
            arr = arr.astype(_DTYPES[info["dtype"]])
        else:
            raise ValueError(f"{path}: {name} has unsupported dtype {info['dtype']}")
        out[name] = arr.reshape(shape)
    return out


def write_safetensors(path: str | Path, tensors: dict[str, np.ndarray]) -> None:
    """float32 tensors as F32 (tests build random models with it)."""
    header, chunks, offset = {}, [], 0
    names = {np.float32: "F32", np.float16: "F16", np.int64: "I64"}
    for name, arr in tensors.items():
        arr = np.ascontiguousarray(arr)
        data = arr.tobytes()
        header[name] = {
            "dtype": names[arr.dtype.type],
            "shape": list(arr.shape),
            "data_offsets": [offset, offset + len(data)],
        }
        chunks.append(data)
        offset += len(data)
    h = json.dumps(header).encode()
    h += b" " * (-len(h) % 8)
    Path(path).write_bytes(struct.pack("<Q", len(h)) + h + b"".join(chunks))
