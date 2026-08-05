from __future__ import annotations

import shutil
import subprocess
import sys
import tarfile
import venv
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
DISALLOWED_PARTS = {
    "dist",
    "build",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}


def test_wheel_sdist_contents_and_installed_imports(tmp_path: Path) -> None:
    shutil.rmtree(DIST, ignore_errors=True)
    subprocess.run([sys.executable, "-m", "build"], cwd=ROOT, check=True)
    subprocess.run(
        [sys.executable, "-m", "twine", "check", "--strict", *DIST.iterdir()], check=True
    )

    wheel = next(DIST.glob("smscode-1.2.0-py3-none-any.whl"))
    sdist = next(DIST.glob("smscode-1.2.0.tar.gz"))

    inspect_wheel(wheel)
    inspect_sdist(sdist)
    smoke_install_wheel(wheel, tmp_path)


def inspect_wheel(wheel: Path) -> None:
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        assert "smscode/py.typed" in names
        for name in names:
            assert name.startswith("smscode/") or ".dist-info/" in name


def inspect_sdist(sdist: Path) -> None:
    with tarfile.open(sdist, "r:gz") as archive:
        for member in archive.getmembers():
            rel = Path(*Path(member.name).parts[1:])
            if not rel.parts:
                continue
            assert not has_disallowed_part(rel), str(rel)
            assert is_allowed_sdist_path(rel), str(rel)


def is_allowed_sdist_path(path: Path) -> bool:
    text = path.as_posix()
    return (
        text in {"LICENSE", "README.md", "pyproject.toml", "uv.lock", ".gitignore", "PKG-INFO"}
        or text.startswith("src/smscode/")
        or text.startswith("tests/")
        or text.startswith("examples/")
    )


def has_disallowed_part(path: Path) -> bool:
    return any(part in DISALLOWED_PARTS or part.endswith(".egg-info") for part in path.parts)


def smoke_install_wheel(wheel: Path, tmp_path: Path) -> None:
    env_dir = tmp_path / "venv"
    venv.create(env_dir, with_pip=True)
    python = env_dir / "bin" / "python"
    subprocess.run([python, "-m", "pip", "install", str(wheel)], check=True)
    subprocess.run(
        [
            python,
            "-c",
            (
                "import importlib.metadata as metadata; "
                "from smscode import VERSION, AsyncSmscodeClient, SmscodeClient, "
                "verify_webhook_signature; "
                "assert VERSION == '1.2.0'; "
                "assert SmscodeClient.__name__ == 'SmscodeClient'; "
                "assert AsyncSmscodeClient.__name__ == 'AsyncSmscodeClient'; "
                "assert callable(verify_webhook_signature); "
                "requirements = metadata.requires('smscode') or []; "
                "assert any(req.startswith('httpx') for req in requirements)"
            ),
        ],
        check=True,
    )
