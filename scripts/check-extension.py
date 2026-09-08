"""Validate CRX payload parity without using a signing key or extracting files."""
import argparse
import hashlib
import io
import json
import struct
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def check_payload(data, expected):
    if data[:4] != b"Cr24" or len(data) < 12:
        raise ValueError("Invalid CRX header")
    version, size = struct.unpack_from("<II", data, 4)
    if version != 3 or 12 + size >= len(data):
        raise ValueError("Invalid CRX3 header")
    with zipfile.ZipFile(io.BytesIO(data[12 + size:])) as bundle:
        names = [entry.filename for entry in bundle.infolist() if not entry.is_dir()]
        if len(names) != len(set(names)) or set(names) != set(expected):
            raise ValueError("CRX file inventory differs from extension/")
        for name in names:
            if bundle.read(name) != expected[name]:
                raise ValueError("Stale CRX payload: " + name)
    return {name: hashlib.sha256(content).hexdigest() for name, content in sorted(expected.items())}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-release", action="store_true")
    args = parser.parse_args()
    expected = {path.relative_to(ROOT / "extension").as_posix(): path.read_bytes()
                for path in (ROOT / "extension").rglob("*") if path.is_file()}
    manifest = json.loads(expected["manifest.json"])
    package = json.loads((ROOT / "package.json").read_text())
    if manifest["version"] != package["version"]:
        raise ValueError("Extension and package versions differ")
    data = (ROOT / "dist/dsh-knowledge-graph.crx").read_bytes()
    files = check_payload(data, expected)
    release = {"version": manifest["version"], "crxSha256": hashlib.sha256(data).hexdigest(), "files": files}
    release_path = ROOT / "dist/extension-release.json"
    if args.write_release:
        release_path.write_text(json.dumps(release, indent=2) + "\n", encoding="utf-8")
    elif json.loads(release_path.read_text()) != release:
        raise ValueError("Release manifest does not match the CRX")
    changed = {**expected, "viewer.js": expected["viewer.js"] + b"\n// different build"}
    try:
        check_payload(data, changed)
    except ValueError:
        pass
    else:
        raise AssertionError("A stale viewer was not rejected")
    print(json.dumps({"ok": True, "version": manifest["version"], "files": len(files), "payloadParity": True, "stalePayloadRejected": True}))


if __name__ == "__main__":
    main()
