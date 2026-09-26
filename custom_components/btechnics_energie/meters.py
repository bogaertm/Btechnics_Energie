"""Meters: per apparaat de sensoren per fase opzoeken (Shelly Pro 3EM en gelijkaardige driefasige meters).

Een driefasige meter heeft per grootheid drie sensoren met hetzelfde apparaat: zonder achtervoegsel
(fase 1), "_2" (fase 2) en "_3" (fase 3). Energie in Wh of kWh, device_class energy, total_increasing.
"""
from __future__ import annotations

import re

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

KINDS = ("energy", "returned", "power", "current", "voltage", "power_factor")


def _phase(entity_id: str) -> int:
    m = re.search(r"_(\d)$", entity_id)
    return int(m.group(1)) if m and m.group(1) in "23" else 1


def meter_entities(hass: HomeAssistant, device_id: str) -> dict:
    """{"energy": {1: id, 2: id, 3: id}, "power": {...}, ...} voor de sensoren van dit apparaat."""
    ent = er.async_get(hass)
    out = {k: {} for k in KINDS}
    for e in er.async_entries_for_device(ent, device_id):
        if e.domain != "sensor" or e.disabled_by:
            continue
        dc = e.device_class or e.original_device_class
        eid = e.entity_id
        if dc == "energy":
            kind = "returned" if "returned" in eid or "return" in (e.original_name or "").lower() else "energy"
        elif dc in ("power", "current", "voltage", "power_factor"):
            kind = dc
        else:
            continue
        out[kind].setdefault(_phase(eid), eid)
    return out


def device_name(hass: HomeAssistant, device_id: str) -> str:
    d = dr.async_get(hass).async_get(device_id)
    return (d.name_by_user or d.name or device_id) if d else device_id


def energy_devices(hass: HomeAssistant) -> list:
    """Apparaten met minstens een energiesensor (voor de keuzelijst in de configuratie)."""
    ent = er.async_get(hass)
    ids = {e.device_id for e in ent.entities.values()
           if e.device_id and e.domain == "sensor" and (e.device_class or e.original_device_class) == "energy"}
    return sorted(ids, key=lambda d: device_name(hass, d).lower())
