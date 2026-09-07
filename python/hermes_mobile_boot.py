"""
Hermes Mobile bootstrap — imported before start_server on iOS.

Does exactly four things:
1. Seeds a psutil stub into sys.modules (iOS has no /proc, no pwd module).
2. Sets sys.platform-keyed env facts Hermes reads (HERMES_HOME, headless).
3. Installs a debug-build Popen wrapper that logs spawn attempts by call site.
4. Exposes request_shutdown() for the Swift host to call.
"""
from __future__ import annotations

import os
import sys
import types
import logging

logger = logging.getLogger("hermes_mobile_boot")

# ── 1. psutil stub ──────────────────────────────────────────────────────────

_psutil = types.ModuleType("psutil")
_psutil.__package__ = "psutil"
_psutil.__path__ = []
_psutil.__file__ = __file__

class NoSuchProcess(Exception):
    def __init__(self, pid: int = 0, name: str = "", msg: str = ""):
        self.pid = pid
        self.name = name
        self.msg = msg or f"process {pid} does not exist"
        super().__init__(self.msg)

class AccessDenied(Exception):
    def __init__(self, pid: int = 0, name: str = "", msg: str = ""):
        self.pid = pid
        self.name = name
        self.msg = msg or f"access denied (pid={pid})"
        super().__init__(self.msg)

class ZombieProcess(Exception):
    def __init__(self, pid: int = 0, name: str = "", ppid: int = 0, msg: str = ""):
        self.pid = pid
        self.name = name
        self.ppid = ppid
        self.msg = msg or f"zombie process (pid={pid})"
        super().__init__(self.msg)

class _VirtualMemory:
    __slots__ = ("total", "available", "percent", "used", "free")
    def __init__(self) -> None:
        try:
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            self.total = pages * page_size
        except (ValueError, OSError):
            self.total = 8 * 1024 * 1024 * 1024  # 8 GB fallback
        self.available = self.total // 2
        self.used = self.total - self.available
        self.free = self.available
        self.percent = (self.used / self.total) * 100.0 if self.total else 0.0

class _StubProcess:
    def __init__(self, pid: int | None = None) -> None:
        self._pid = pid if pid is not None else os.getpid()
        if self._pid != os.getpid():
            raise NoSuchProcess(self._pid)
    def pid(self) -> int: return self._pid
    def name(self) -> str: return "hermes-mobile"
    def is_running(self) -> bool: return self._pid == os.getpid()
    def status(self) -> str: return "running"
    def cmdline(self) -> list[str]: return [sys.executable]
    def memory_info(self): return types.SimpleNamespace(rss=0, vms=0)
    def cpu_percent(self, interval: float | None = None) -> float: return 0.0

def _pid_exists(pid: int) -> bool:
    return pid == os.getpid()

def _process_iter(attrs: list[str] | None = None, ad_value: object = None):
    return iter(())

def _virtual_memory() -> _VirtualMemory:
    return _VirtualMemory()

_psutil.NoSuchProcess = NoSuchProcess
_psutil.AccessDenied = AccessDenied
_psutil.ZombieProcess = ZombieProcess
_psutil.Process = _StubProcess
_psutil.pid_exists = _pid_exists
_psutil.process_iter = _process_iter
_psutil.virtual_memory = _virtual_memory
_psutil.STATUS_RUNNING = "running"
_psutil.STATUS_ZOMBIE = "zombie"

sys.modules["psutil"] = _psutil
sys.modules["psutil._common"] = types.ModuleType("psutil._common")
sys.modules["psutil._common"].__package__ = "psutil"

# ── 2. Environment ──────────────────────────────────────────────────────────

# HERMES_HOME, HERMES_SERVE_HEADLESS, HERMES_DASHBOARD_SESSION_TOKEN, and
# SSL_CERT_FILE are set by PythonRuntime.swift before Py_Initialize.
# We verify the critical ones here.

_hermes_home = os.environ.get("HERMES_HOME")
if not _hermes_home:
    raise RuntimeError("HERMES_HOME must be set by the Swift host before boot")

os.makedirs(_hermes_home, exist_ok=True)

# ── 3. Debug Popen wrapper ──────────────────────────────────────────────────

_spawn_log: list[dict] = []

def get_spawn_log() -> list[dict]:
    """Return all subprocess spawn attempts recorded since boot."""
    return list(_spawn_log)

def clear_spawn_log() -> None:
    _spawn_log.clear()

if os.environ.get("HERMES_MOBILE_DEBUG") == "1":
    import subprocess
    import traceback

    _original_popen_init = subprocess.Popen.__init__

    def _logged_popen_init(self, args, **kwargs):  # type: ignore[no-untyped-def]
        entry = {
            "args": str(args)[:500],
            "stack": "".join(traceback.format_stack(limit=8)),
        }
        _spawn_log.append(entry)
        logger.warning("subprocess.Popen attempt: %s", entry["args"])
        return _original_popen_init(self, args, **kwargs)

    subprocess.Popen.__init__ = _logged_popen_init  # type: ignore[assignment]

# ── 4. Shutdown hook ────────────────────────────────────────────────────────

_server_ref: object | None = None

def set_server(server: object) -> None:
    """Called by the boot sequence after start_server binds."""
    global _server_ref
    _server_ref = server

def request_shutdown() -> None:
    """Called by PythonRuntime.swift to cleanly stop the gateway."""
    if _server_ref is not None and hasattr(_server_ref, "should_exit"):
        _server_ref.should_exit = True  # type: ignore[attr-defined]
        logger.info("Shutdown requested via request_shutdown()")
    else:
        logger.warning("request_shutdown() called but no server reference set")

def is_server_alive() -> bool:
    """Called by PythonRuntime.swift to check if the gateway thread is responsive."""
    if _server_ref is None:
        return False
    return not getattr(_server_ref, "should_exit", True)
