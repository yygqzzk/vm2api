"""Install the pinned Linux browser; optional local archives are verified identically."""
import hashlib
import shutil
import stat
import sys
import urllib.request
import zipfile
from pathlib import Path

VERSION = "156.0.8078.79"
ARCHIVES = {
    "amd64": ("chromix-linux-x64.zip", "1cabcc4e2136cf3e2f6d0ab4a61b1e5d2e0047d5b3b68e17f91405fe50531b9e"),
    "arm64": ("chromix-linux-arm64.zip", "f425bfd53748fd7f3c9ca366675215435ba5cb8429479bce4788e0294fec46f9"),
}


def install(architecture, archives, destination):
    if architecture not in ARCHIVES:
        raise ValueError("Chromix requires amd64 or arm64")
    name, expected = ARCHIVES[architecture]
    archive = Path(archives) / name
    if not archive.exists():
        url = f"https://github.com/xiaozhou26/Chromix/releases/download/v{VERSION}/{name}"
        with urllib.request.urlopen(url, timeout=60) as source, archive.open("wb") as target:
            shutil.copyfileobj(source, target)
    digest = hashlib.sha256()
    with archive.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise ValueError("Chromix archive SHA-256 mismatch")
    root = Path(destination)
    with zipfile.ZipFile(archive) as bundle:
        for item in bundle.infolist():
            path = Path(item.filename)
            mode = item.external_attr >> 16
            if (path.is_absolute() or ".." in path.parts or not path.parts
                    or path.parts[0] != "chromix" or stat.S_ISLNK(mode)):
                raise ValueError("unexpected Chromix archive entry")
        bundle.extractall(root)
        for item in bundle.infolist():
            mode = (item.external_attr >> 16) & 0o777
            if mode:
                (root / item.filename).chmod(mode)
    browser = root / "chromix"
    for name in ("chrome", "chromix", "chrome_crashpad_handler", "chrome-sandbox"):
        (browser / name).chmod(0o755)


if __name__ == "__main__":
    install(sys.argv[1], sys.argv[2], sys.argv[3])
