"""Configuratie: kies de energiemeters (apparaten met energiesensoren per fase)."""
import re

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers.selector import SelectOptionDict, SelectSelector, SelectSelectorConfig

from .const import CONF_METERS, DOMAIN
from .meters import device_name, energy_devices, meter_entities


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "meter"


def _schema(hass, default=None):
    opts = [SelectOptionDict(value=d, label=device_name(hass, d)) for d in energy_devices(hass)]
    return vol.Schema({vol.Required("devices", default=default or []): SelectSelector(
        SelectSelectorConfig(options=opts, multiple=True))})


def _meters(hass, devices, existing=None):
    """existing: de meters van voor de wijziging. Een apparaat dat al gekozen was, houdt zijn id, ook als het
    intussen hernoemd is: evenementen bewaren die id, anders zou een afrekening naar andere meters kijken."""
    keep = {m["device_id"]: m["id"] for m in (existing or [])}
    out, seen = [], set(keep[d] for d in devices if d in keep)
    for d in devices:
        # "Energiemeter Speldenstraat Voorbouw" wordt "Speldenstraat Voorbouw"
        name = re.sub(r"^(energiemeter|energie meter|meter)\s+", "", device_name(hass, d), flags=re.I).strip() or device_name(hass, d)
        if d in keep:
            out.append({"id": keep[d], "name": name, "device_id": d})
            continue
        mid = _slug(name)
        while mid in seen:
            mid += "_2"
        seen.add(mid)
        out.append({"id": mid, "name": name, "device_id": d})
    return out


def _check(hass, devices):
    if not devices:
        return "no_meters"
    for d in devices:
        if not meter_entities(hass, d)["energy"]:
            return "no_energy"
    return None


class BtechnicsEnergieConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors = {}
        if user_input is not None:
            err = _check(self.hass, user_input["devices"])
            if err:
                errors["base"] = err
            else:
                return self.async_create_entry(title="Btechnics Energie",
                                               data={CONF_METERS: _meters(self.hass, user_input["devices"])})
        return self.async_show_form(step_id="user", data_schema=_schema(self.hass), errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(entry):
        return OptionsFlow()


class OptionsFlow(config_entries.OptionsFlow):
    async def async_step_init(self, user_input=None):
        errors = {}
        if user_input is not None:
            err = _check(self.hass, user_input["devices"])
            if err:
                errors["base"] = err
            else:
                self.hass.config_entries.async_update_entry(
                    self.config_entry, data={CONF_METERS: _meters(self.hass, user_input["devices"],
                                                                  self.config_entry.data.get(CONF_METERS, []))})
                return self.async_create_entry(data={})
        cur = [m["device_id"] for m in self.config_entry.data.get(CONF_METERS, [])]
        return self.async_show_form(step_id="init", data_schema=_schema(self.hass, cur), errors=errors)
