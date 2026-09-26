import pytest

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(recorder_mock, enable_custom_integrations):
    yield


@pytest.fixture(autouse=True)
def clean_db():
    """Elke test een lege kwartierdatabank (zonder hass: de recorder moet eerst opstarten)."""
    import os
    from pytest_homeassistant_custom_component.common import get_test_config_dir
    from custom_components.btechnics_energie.const import QUARTER_DB

    base = get_test_config_dir(QUARTER_DB)

    def _rm():
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(base + suffix):
                os.remove(base + suffix)

    _rm()
    yield
    _rm()
