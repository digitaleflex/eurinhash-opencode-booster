"""Where Tollfree and OpenCode keep their files, on any OS.

Config dir resolution: TOLLFREE_DIR > OPENCODE_CONFIG_DIR > $XDG_CONFIG_HOME/opencode
> ~/.config/opencode (OpenCode's own default on Linux, macOS and Windows).
"""
import os
from pathlib import Path


def _env(name):
    value = (os.environ.get(name) or "").strip()
    return value or None


def config_dir() -> str:
    """Resolve the config dir and create it, so scripts can write state on a fresh install."""
    explicit = _env("TOLLFREE_DIR") or _env("OPENCODE_CONFIG_DIR")
    base = _env("XDG_CONFIG_HOME") or os.path.join(str(Path.home()), ".config")
    path = os.path.expanduser(explicit) if explicit else os.path.join(base, "opencode")
    try:
        os.makedirs(path, exist_ok=True)
    except OSError:
        pass
    return path


def data_dir() -> str:
    """OpenCode's data dir (holds opencode.db)."""
    base = _env("XDG_DATA_HOME") or os.path.join(str(Path.home()), ".local", "share")
    return os.path.join(base, "opencode")
