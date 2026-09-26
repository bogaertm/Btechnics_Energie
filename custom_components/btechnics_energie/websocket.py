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
    for cmd in (ws_days, ws_day, ws_peaks, ws_tariff_set, ws_tariff_delete,
                ws_events, ws_event_save, ws_event_delete, ws_event_report):
        websocket_api.async_register_command(hass, cmd)


def _ready(hass, connection, msg):
    en = _energy(hass)
    if en is None:
        connection.send_error(msg["id"], "not_ready", "Btechnics Energie is nog niet geladen")
    return en


def _date(s: str) -> date:
    return date.fromisoformat(s)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/days", vol.Required("start"): DATE, vol.Required("end"): DATE,
                                  vol.Optional("meters"): [str]})
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
    res = await en.days(s, e, msg.get("meters"))
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


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/peaks", vol.Optional("meters"): [str]})
@websocket_api.async_response
async def ws_peaks(hass, connection, msg):
    en = _ready(hass, connection, msg)
    if en is None:
        return
    connection.send_result(msg["id"], await en.peaks(msg.get("meters")))


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


# ---------- evenementen (enkel beheerders: bevat namen en contactgegevens van organisatoren) ----------
EVENT = {
    vol.Required("name"): vol.All(str, vol.Length(min=1, max=200)),
    vol.Optional("organizer", default=""): vol.All(str, vol.Length(max=200)),
    vol.Optional("contact", default=""): vol.All(str, vol.Length(max=300)),
    vol.Required("start"): str,
    vol.Required("end"): str,
    vol.Required("meters"): vol.All([str], vol.Length(min=1)),
    vol.Optional("price"): vol.Any(None, vol.All(vol.Coerce(float), vol.Range(min=0, max=5))),
    vol.Optional("note", default=""): vol.All(str, vol.Length(max=2000)),
}


def _event_times(hass, data):
    """Begin en einde (datum en uur zonder tijdzone = tijdzone van Home Assistant) naar ISO met tijdzone."""
    out = {}
    for k in ("start", "end"):
        dt = dt_util.parse_datetime(data[k])
        if dt is None:
            raise ValueError(f"ongeldige datum en uur: {data[k]}")
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=dt_util.get_default_time_zone())
        out[k] = dt_util.as_local(dt).isoformat(timespec="minutes")
    if out["end"] <= out["start"] and dt_util.parse_datetime(out["end"]) <= dt_util.parse_datetime(out["start"]):
        raise ValueError("het einde moet na het begin liggen")
    if (dt_util.parse_datetime(out["end"]) - dt_util.parse_datetime(out["start"])).days > 62:
        raise ValueError("een evenement duurt maximaal 62 dagen")
    return out


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/events"})
@websocket_api.async_response
async def ws_events(hass, connection, msg):
    en = _ready(hass, connection, msg)
    if en is None:
        return
    items = []
    for ev in en.events.list():
        try:
            rep = await en.event_report(ev)
            items.append({**ev, "total": rep["total"], "amount": rep["amount"], "price_used": rep["price"]})
        except Exception:  # noqa: BLE001  een kapot evenement mag de lijst niet blokkeren
            items.append(ev)
    connection.send_result(msg["id"], {"events": items, "meters": en._meta(), "tariffs": en.tariff_items})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/event/save", vol.Optional("event_id"): str, **EVENT})
@websocket_api.async_response
async def ws_event_save(hass, connection, msg):
    en = _ready(hass, connection, msg)
    if en is None:
        return
    try:
        times = _event_times(hass, msg)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    known = {m["id"] for m in en.meters}
    if not set(msg["meters"]) <= known:
        connection.send_error(msg["id"], "invalid_format", "onbekende meter")
        return
    eid = msg.get("event_id")
    if eid and not en.events.get(eid):
        connection.send_error(msg["id"], "not_found", "evenement niet gevonden")
        return
    data = {k: msg.get(k) for k in ("name", "organizer", "contact", "meters", "price", "note")}
    data["name"] = data["name"].strip()
    ev = await en.events.save({**data, **times}, eid)
    connection.send_result(msg["id"], {"event": ev})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/event/delete", vol.Required("event_id"): str})
@websocket_api.async_response
async def ws_event_delete(hass, connection, msg):
    en = _ready(hass, connection, msg)
    if en is None:
        return
    await en.events.delete(msg["event_id"])
    connection.send_result(msg["id"], {})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/event/report", vol.Optional("event_id"): str,
                                  vol.Optional("draft"): dict})
@websocket_api.async_response
async def ws_event_report(hass, connection, msg):
    """Rapport van een bewaard evenement, of van een ontwerp (nog niet bewaard) om vooraf na te kijken."""
    en = _ready(hass, connection, msg)
    if en is None:
        return
    if msg.get("event_id"):
        ev = en.events.get(msg["event_id"])
        if ev is None:
            connection.send_error(msg["id"], "not_found", "evenement niet gevonden")
            return
    else:
        try:
            d = vol.Schema(EVENT, extra=vol.REMOVE_EXTRA)(msg.get("draft") or {})
            ev = {**d, **_event_times(hass, d)}
        except (vol.Invalid, ValueError) as err:
            connection.send_error(msg["id"], "invalid_format", str(err))
            return
    connection.send_result(msg["id"], await en.event_report(ev))
