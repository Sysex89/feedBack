import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

PLUGIN_DIR = Path(__file__).parent.parent.parent.parent / 'plugins' / 'tutor'
sys.path.insert(0, str(PLUGIN_DIR))

# Drop siblings cached by another plugin's tests (bare-name collision).
for _name in ('routes', 'exercises', 'analysis', 'diagnostics'):
    sys.modules.pop(_name, None)
import analysis as tutor_analysis  # noqa: E402
import exercises as tutor_exercises  # noqa: E402
import routes as tutor_routes  # noqa: E402


@pytest.fixture(autouse=True)
def _bind_tutor_modules():
    prev = {n: sys.modules.get(n) for n in ('routes', 'exercises', 'analysis')}
    sys.modules['routes'] = tutor_routes
    sys.modules['exercises'] = tutor_exercises
    sys.modules['analysis'] = tutor_analysis
    try:
        yield
    finally:
        for n, m in prev.items():
            if m is not None:
                sys.modules[n] = m
            else:
                sys.modules.pop(n, None)


@pytest.fixture
def dlc(tmp_path):
    d = tmp_path / 'dlc'
    d.mkdir()
    return d


@pytest.fixture
def xp_log():
    return []


@pytest.fixture
def client(tmp_path, dlc, xp_log):
    app = FastAPI()
    cfg = tmp_path / 'config'
    cfg.mkdir()
    tutor_routes.setup(app, {
        'config_dir': str(cfg),
        'get_dlc_dir': lambda: dlc,
        'award_xp': lambda amount, source=None: xp_log.append((amount, source)),
        'kick_scan': lambda force=False: xp_log.append(('scan', force)),
    })
    return TestClient(app)
