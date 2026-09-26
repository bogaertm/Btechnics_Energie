"""Btechnics Energie: verbruik, kost per dag en kwartierpieken, met een eigen dashboardkaart."""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import KEY_HASS, HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.start import async_at_started
from homeassistant.loader import async_get_integration

from .const import CONF_METERS, DOMAIN, QUARTER_DB
from .data import Energy, QuarterDB
from .websocket import async_register as async_register_websocket

_LOGGER = logging.getLogger(__name__)

CARDS_URL = "/btechnics_energie_static"
CARDS_FILE = "btechnics-energie-card.js"
GLOBAL_KEY = f"{DOMAIN}_global"
# oude tariefhelper van het vorige dashboard: de waarde wordt het eerste tarief
LEGACY_TARIFF = "input_number.energietarief_per_kwh"


async def _async_global_setup(hass: HomeAssistant):
    if hass.data.get(GLOBAL_KEY):
        return
    hass.data[GLOBAL_KEY] = True
    async_register_websocket(hass)
    if getattr(hass, "http", None) is not None:
        hass.http.register_view(EventPdfView())
    if getattr(hass, "http", None) is None or "frontend" not in hass.config.components:
        return
    from homeassistant.components.frontend import add_extra_js_url
    from homeassistant.components.http import StaticPathConfig

    version = (await async_get_integration(hass, DOMAIN)).version
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARDS_URL, str(Path(__file__).parent / "frontend"), False)])
    add_extra_js_url(hass, f"{CARDS_URL}/{CARDS_FILE}?v={version}")

    async def _at_start(_hass):
        await _async_ensure_resource(hass, version)

    async_at_started(hass, _at_start)


async def _async_ensure_resource(hass: HomeAssistant, version: str):
    """Ook als dashboardresource, zodat een oude kopie van de pagina (service worker) de kaart toch laadt."""
    try:
        resources = getattr(hass.data.get("lovelace"), "resources", None)
        if resources is None or not hasattr(resources, "async_create_item"):
            return
        await resources.async_load()
        base = f"{CARDS_URL}/{CARDS_FILE}"
        url = f"{base}?v={version}"
        mine = [r for r in resources.async_items() if str(r.get("url", "")).split("?")[0] == base]
        if not mine:
            await resources.async_create_item({"res_type": "module", "url": url})
        elif mine[0].get("url") != url:
            await resources.async_update_item(mine[0]["id"], {"res_type": "module", "url": url})
        for extra in mine[1:]:
            await resources.async_delete_item(extra["id"])
    except Exception:  # noqa: BLE001
        _LOGGER.exception("Dashboardresource voor de energiekaart registreren mislukt")


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    await _async_global_setup(hass)
    db = await hass.async_add_executor_job(QuarterDB, hass.config.path(QUARTER_DB))
    en = Energy(hass, entry.data.get(CONF_METERS, []), db)
    await en.load()
    if not en.tariff_items:
        st = hass.states.get(LEGACY_TARIFF)
        try:
            price = float(st.state) if st else None
        except ValueError:
            price = None
        if price:
            await en.set_tariff("2000-01-01", price)
            _LOGGER.info("Eerste tarief overgenomen uit %s: %s EUR/kWh", LEGACY_TARIFF, price)
    hass.data[DOMAIN] = en

    async def _quarters(_now=None, hours=3):
        try:
            await en.import_quarters(hours)
        except Exception:  # noqa: BLE001  volgende keer opnieuw
            _LOGGER.exception("Kwartieren overnemen mislukt")

    # 5-minuutstatistieken zijn er kort na elk 5-minutenblok; 40 s later overnemen
    entry.async_on_unload(async_track_time_change(hass, _quarters, minute=list(range(0, 60, 5)), second=40))

    async def _backfill(_hass):
        await _quarters(hours=24 * 10)   # alles wat Home Assistant nog heeft (10 dagen)

    entry.async_on_unload(async_at_started(hass, _backfill))
    entry.async_on_unload(entry.add_update_listener(_reload))
    return True


async def _reload(hass: HomeAssistant, entry: ConfigEntry):
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.pop(DOMAIN, None)
    return True


class EventPdfView(HomeAssistantView):
    """PDF-afrekening van een evenement, enkel voor beheerders (de kaart gebruikt een ondertekend pad)."""

    url = "/api/btechnics_energie/evenement/{event_id}/pdf"
    name = "api:btechnics_energie:evenement_pdf"
    requires_auth = True

    async def get(self, request, event_id: str):
        from aiohttp import web
        from homeassistant.util import dt as dt_util
        from .pdf import build_pdf

        user = request.get("hass_user")
        if user is None or not user.is_admin:
            return web.Response(status=403, text="Enkel voor beheerders")
        hass = request.app[KEY_HASS]
        en = hass.data.get(DOMAIN)
        ev = en.events.get(event_id) if en else None
        if ev is None:
            return web.Response(status=404, text="Evenement niet gevonden")
        report = await en.event_report(ev)
        data = await hass.async_add_executor_job(
            build_pdf, report, lambda t: dt_util.as_local(dt_util.utc_from_timestamp(t)), dt_util.now())
        fname = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in f"{ev.get('number', 'evenement')}-{ev.get('name', '')}")[:80]
        return web.Response(body=data, content_type="application/pdf",
                            headers={"Content-Disposition": f'inline; filename="{fname}.pdf"', "Cache-Control": "no-store"})
