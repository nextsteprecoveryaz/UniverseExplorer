"""The isolated GPU worker must end when its owning app/job goes away."""
import importlib.util
from pathlib import Path
import os

import pytest


@pytest.fixture
def worker(monkeypatch):
    spec = importlib.util.spec_from_file_location(
        'trellis_worker_test', Path(__file__).resolve().parents[1] / 'scripts' / 'trellis_worker.py'
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def process_exit(code):
        raise SystemExit(code)

    monkeypatch.setattr(module.os, '_exit', process_exit)
    return module


def test_job_cancel_exits_own_worker(worker, tmp_path):
    marker = tmp_path / 'cancel'
    marker.touch()
    with pytest.raises(SystemExit) as exit_info:
        worker.watch_cancellation(marker, None)
    assert exit_info.value.code == 130


def test_stale_owner_heartbeat_exits_worker(worker, tmp_path):
    heartbeat = tmp_path / 'heartbeat'
    heartbeat.touch()
    os.utime(heartbeat, (1, 1))
    with pytest.raises(SystemExit) as exit_info:
        worker.watch_cancellation(None, heartbeat)
    assert exit_info.value.code == 130


def test_closed_progress_pipe_does_not_prevent_gpu_cleanup(worker, tmp_path, monkeypatch):
    marker = tmp_path / 'cancel'
    marker.touch()

    def broken_pipe(*args, **kwargs):
        raise BrokenPipeError()

    monkeypatch.setattr(worker, 'progress', broken_pipe)
    with pytest.raises(SystemExit) as exit_info:
        worker.watch_cancellation(marker, None)
    assert exit_info.value.code == 130


def test_standalone_worker_has_no_owner_watchdog(worker):
    assert worker.watch_cancellation(None, None) is None
