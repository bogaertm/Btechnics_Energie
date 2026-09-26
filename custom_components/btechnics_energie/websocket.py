"""WebSocket-commando's voor de kaart. Lezen voor elke gebruiker, tarieven wijzigen enkel voor beheerders."""
from datetime import date

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.util import dt as dt_util

from .const import DOMAIN

DATE = vol.Match(r"^\d{4}-\d{2}-\d{2}$")


def _energy(hass):
    return hass.data.get(DOMAIN)


@callback
def async_register(hass: HomeAssistant):
    for cmd in (ws_days, ws_day, ws_peaks, ws_tariff_set, ws_tariff_delete):
        websocket_api.async_register_command(hass, cmd)


def _ready(hass, connection, msg):
    en = _energy(hass)
    if en is None:
        connection.send_error(msg["id"], "not_ready", "Btechnics Energie is nog niet geladen")
    return en


def _date(s: str) -> date:
    return date.fromisoformat(s)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/days", vol.Required("start"): DATE, vol.Required("end"): DATE})
@websocket_api.async_response
async def ws_days(hass, connection, msg):
    en = _ready(hass, connection, msg)
    if en is None:
        return
    try:
        s, e = _date(msg["start"]), _date(msg["end"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    if e < s or (e - s).days > 800:
        connection.send_error(msg["id"], "invalid_format", "periode ongeldig (maximaal 800 dagen)")
        return
    res = await en.days(s, e)
    res["today"] = dt_util.now().date().isoformat()
    res["time_zone"] = hass.config.time_zone
    connection.send_result(msg["id"], res)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/day", vol.Required("date"): DATE})
@websocket_api.async_response
async def ws_day(hass, connection, msg):
    en = _ready(hass, connection, msg)
    if en is None:
        return
    try:
        d = _date(msg["date"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    connection.send_result(msg["id"], await en.day(d))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/peaks"})
@websocket_api.async_response
async def ws_peaks(hass, connection, msg):
    en = _ready(hass, connection, msg)
    if en is None:
        return
    connection.send_result(msg["id"], await en.peaks())


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/tariff/set", vol.Required("from"): DATE,
                                  vol.Required("price"): vol.All(vol.Coerce(float), vol.Range(min=0, max=5))})
@websocket_api.async_response
async def ws_tariff_set(hass, connection, msg):
    en = _ready(hass, connection, msg)
    if en is None:
        return
    try:
        _date(msg["from"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    await en.set_tariff(msg["from"], msg["price"])
    connection.send_result(msg["id"], {"tariffs": en.tariff_items})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/tariff/delete", vol.Required("from"): DATE})
@websocket_api.async_response
async def ws_tariff_delete(hass, connection, msg):
    en = _ready(hass, connection, msg)
    if en is None:
        return
    if len(en.tariff_items) <= 1:
        connection.send_error(msg["id"], "invalid_format", "er moet minstens een tarief blijven")
        return
    await en.delete_tariff(msg["from"])
    connection.send_result(msg["id"], {"tariffs": en.tariff_items})
