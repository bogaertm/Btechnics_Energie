"""Evenementen (sessies, optredens, expo's): naam, organisator, periode, meters en doorrekenprijs.
Bewaard in .storage/btechnics_energie_evenementen."""
from __future__ import annotations

import uuid

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

STORE_KEY = "btechnics_energie_evenementen"
FIELDS = ("name", "organizer", "contact", "start", "end", "meters", "price", "note")


class EventStore:
    def __init__(self, hass: HomeAssistant):
        self.store = Store(hass, 1, STORE_KEY)
        self.items: dict = {}
        self.seq: dict = {}          # volgnummer per jaar: EV-2026-001

    async def load(self):
        data = await self.store.async_load() or {}
        self.items = data.get("items", {})
        self.seq = data.get("seq", {})

    async def _save(self):
        await self.store.async_save({"items": self.items, "seq": self.seq})

    def list(self) -> list:
        return sorted(self.items.values(), key=lambda e: e["start"], reverse=True)

    def get(self, eid: str) -> dict | None:
        return self.items.get(eid)

    async def save(self, data: dict, eid: str | None = None) -> dict:
        now = dt_util.now().isoformat(timespec="seconds")
        if eid:
            ev = self.items[eid]
        else:
            year = data["start"][:4]
            n = self.seq.get(year, 0) + 1
            self.seq[year] = n
            eid = uuid.uuid4().hex[:10]
            ev = {"id": eid, "number": f"EV-{year}-{n:03d}", "created": now}
            self.items[eid] = ev
        for k in FIELDS:
            if k in data:
                ev[k] = data[k]
        ev["updated"] = now
        await self._save()
        return ev

    async def delete(self, eid: str):
        self.items.pop(eid, None)
        await self._save()
