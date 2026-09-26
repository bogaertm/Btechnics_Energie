"""Gegevens: uur-, dag- en maandverbruik uit de statistieken van Home Assistant (worden nooit gewist),
kwartieren uit de 5-minuutstatistieken (die bewaart Home Assistant maar 10 dagen, dus worden ze hier
elke 5 minuten overgenomen in een eigen databank en blijven ze bewaard)."""
from __future__ import annotations

import logging
import sqlite3
import threading
from contextlib import closing
from datetime import date, datetime, timedelta

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.statistics import statistics_during_period
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .calc import Tariffs, billing_peak, month_peaks, quarters_from_5min
from .const import STORE_KEY, STORE_VERSION
from .meters import device_name, meter_entities

_LOGGER = logging.getLogger(__name__)

PHASES = (1, 2, 3)


class QuarterDB:
    def __init__(self, path: str):
        self._path = path
        self._lock = threading.Lock()
        with self._lock, closing(self._conn()) as c, c:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("CREATE TABLE IF NOT EXISTS quarter (meter TEXT NOT NULL, ts INTEGER NOT NULL, kwh REAL NOT NULL, "
                      "PRIMARY KEY (meter, ts))")

    def _conn(self):
        return sqlite3.connect(self._path, timeout=30)

    def upsert(self, quarters: dict) -> int:
        rows = [(m, int(ts), float(k)) for ts, per in quarters.items() for m, k in per.items()]
        if not rows:
            return 0
        with self._lock, closing(self._conn()) as c, c:
            c.executemany("INSERT INTO quarter (meter, ts, kwh) VALUES (?, ?, ?) "
                          "ON CONFLICT(meter, ts) DO UPDATE SET kwh = excluded.kwh", rows)
        return len(rows)

    def between(self, start: int, end: int) -> dict:
        """{ts: {meter: kWh}} voor start <= ts < end."""
        out = {}
        with closing(self._conn()) as c:
            for m, ts, k in c.execute("SELECT meter, ts, kwh FROM quarter WHERE ts >= ? AND ts < ? ORDER BY ts", (start, end)):
                out.setdefault(ts, {})[m] = k
        return out

    def first(self):
        with closing(self._conn()) as c:
            return c.execute("SELECT MIN(ts) FROM quarter").fetchone()[0]


class Energy:
    def __init__(self, hass: HomeAssistant, meters: list, db: QuarterDB):
        self.hass = hass
        self.db = db
        self.meters = []
        for m in meters:
            ents = meter_entities(hass, m["device_id"])
            self.meters.append({**m, "name": m.get("name") or device_name(hass, m["device_id"]), "ents": ents})
        self.store = Store(hass, STORE_VERSION, STORE_KEY)
        self.tariff_items = []

    # ---------- tarieven ----------
    async def load(self):
        data = await self.store.async_load() or {}
        self.tariff_items = data.get("items", [])

    @property
    def tariffs(self) -> Tariffs:
        return Tariffs(self.tariff_items)

    async def set_tariff(self, day: str, price: float):
        self.tariff_items = [i for i in self.tariff_items if i["from"] != day] + [{"from": day, "price": round(price, 5)}]
        self.tariff_items.sort(key=lambda i: i["from"])
        await self.store.async_save({"items": self.tariff_items})

    async def delete_tariff(self, day: str):
        self.tariff_items = [i for i in self.tariff_items if i["from"] != day]
        await self.store.async_save({"items": self.tariff_items})

    # ---------- statistieken ----------
    def _energy_ids(self) -> dict:
        return {m["id"]: [m["ents"]["energy"][p] for p in PHASES if p in m["ents"]["energy"]] for m in self.meters}

    async def _stats(self, ids, start: datetime, end: datetime, period: str, types: set, units=None) -> dict:
        return await get_instance(self.hass).async_add_executor_job(
            statistics_during_period, self.hass, start, end, set(ids), period, units, types)

    async def _energy(self, start: datetime, end: datetime, period: str) -> dict:
        """{meter: {start_ts: kWh}} (som van de fasen) en {entity: {start_ts: kWh}} per fase."""
        per_meter = self._energy_ids()
        ids = [e for v in per_meter.values() for e in v]
        rows = await self._stats(ids, start, end, period, {"change"}, {"energy": "kWh"})
        # de recorder geeft ook de rij die precies op het einde begint: die hoort niet bij de periode
        s_ts, e_ts = start.timestamp(), end.timestamp()
        by_ent = {e: {int(r["start"]): r.get("change") for r in rows.get(e, [])
                      if r.get("change") is not None and s_ts <= r["start"] < e_ts} for e in ids}
        meters = {}
        for mid, ents in per_meter.items():
            acc = {}
            for e in ents:
                for ts, v in by_ent[e].items():
                    acc[ts] = acc.get(ts, 0.0) + v
            meters[mid] = acc
        return meters, by_ent

    # ---------- kwartieren ----------
    async def import_quarters(self, hours: int = 3) -> int:
        """Volledige kwartieren uit de 5-minuutstatistieken overnemen (dubbel overnemen kan geen kwaad)."""
        end = dt_util.utcnow()
        start = end - timedelta(hours=hours)
        meters, _ = await self._energy(start, end, "5minute")
        q = quarters_from_5min({m: list(v.items()) for m, v in meters.items()}, dt_util.get_default_time_zone())
        # enkel kwartieren waarvoor alle meters gegevens hebben
        q = {ts: per for ts, per in q.items() if len(per) == len(self.meters)}
        return await self.hass.async_add_executor_job(self.db.upsert, q)

    # ---------- hulp ----------
    @staticmethod
    def _local_midnight(d: date) -> datetime:
        return dt_util.start_of_local_day(d)

    @staticmethod
    def _local_day(ts: float) -> str:
        return dt_util.as_local(dt_util.utc_from_timestamp(ts)).date().isoformat()

    def _meta(self):
        return [{"id": m["id"], "name": m["name"],
                 "power": {str(p): e for p, e in m["ents"]["power"].items()},
                 "current": {str(p): e for p, e in m["ents"]["current"].items()},
                 "voltage": {str(p): e for p, e in m["ents"]["voltage"].items()}} for m in self.meters]

    # ---------- per dag ----------
    async def days(self, start: date, end: date) -> dict:
        """Per dag (lokale tijd, start en end inbegrepen): kWh per meter, totaal, tarief, kost, kwartierpiek."""
        s, e = self._local_midnight(start), self._local_midnight(end + timedelta(days=1))
        meters, _ = await self._energy(s, e, "day")
        quarters = await self.hass.async_add_executor_job(self.db.between, int(s.timestamp()), int(e.timestamp()))
        peaks = {}
        for ts, per in quarters.items():
            if len(per) != len(self.meters):
                continue
            d = self._local_day(ts)
            kw = sum(per.values()) * 4
            if d not in peaks or kw > peaks[d]["kw"]:
                peaks[d] = {"kw": round(kw, 3), "ts": ts}
        t = self.tariffs
        out, days = [], {}
        for mid, per in meters.items():
            for ts, k in per.items():
                days.setdefault(self._local_day(ts), {})[mid] = k
        for d in sorted(days):
            per = days[d]
            total = sum(per.values())
            price = t.price(d)
            out.append({"date": d, "meters": {m: round(v, 3) for m, v in per.items()}, "total": round(total, 3),
                        "price": price, "cost": round(total * price, 4) if price is not None else None,
                        "peak": peaks.get(d)})
        return {"days": out, "meters": self._meta(), "tariffs": self.tariff_items}

    # ---------- een dag in detail ----------
    async def day(self, d: date) -> dict:
        s, e = self._local_midnight(d), self._local_midnight(d + timedelta(days=1))
        meters, by_ent = await self._energy(s, e, "hour")
        hours = {}
        for mid, per in meters.items():
            for ts, k in per.items():
                hours.setdefault(ts, {})[mid] = round(k, 4)
        quarters = await self.hass.async_add_executor_job(self.db.between, int(s.timestamp()), int(e.timestamp()))
        price = self.tariffs.price(d)
        # fasen: vermogen, stroom, spanning; 5 minuten als het nog kan (Home Assistant bewaart die 10 dagen)
        recent = dt_util.utcnow() - s < timedelta(days=9)
        period = "5minute" if recent else "hour"
        ids = [x for m in self.meters for k in ("power", "current", "voltage") for x in m["ents"][k].values()]
        pstats = await self._stats(ids, s, e, period, {"mean", "max", "min"})
        phases = {}
        for m in self.meters:
            pm = {}
            for p in PHASES:
                ph = {}
                for k in ("power", "current", "voltage"):
                    eid = m["ents"][k].get(p)
                    rows = pstats.get(eid, []) if eid else []
                    ph[k] = [[int(r["start"]), r.get("mean"), r.get("max"), r.get("min")] for r in rows
                             if s.timestamp() <= r["start"] < e.timestamp()]
                ee = m["ents"]["energy"].get(p)
                ph["kwh"] = round(sum(by_ent.get(ee, {}).values()), 3) if ee else None
                pm[str(p)] = ph
            phases[m["id"]] = pm
        return {"date": d.isoformat(), "start": int(s.timestamp()), "end": int(e.timestamp()), "price": price,
                "hours": [{"ts": ts, "meters": per} for ts, per in sorted(hours.items())],
                "quarters": [{"ts": ts, "meters": per} for ts, per in sorted(quarters.items())],
                "phase_period": period, "phases": phases, "meters": self._meta()}

    # ---------- pieken per maand ----------
    async def peaks(self) -> dict:
        now = dt_util.now()
        start = int((now - timedelta(days=400)).timestamp())
        quarters = await self.hass.async_add_executor_job(self.db.between, start, int(now.timestamp()) + 900)
        rows = []
        top = []
        for ts, per in quarters.items():
            if len(per) != len(self.meters):
                continue
            local = dt_util.as_local(dt_util.utc_from_timestamp(ts))
            total = sum(per.values())
            rows.append((ts, local.strftime("%Y-%m"), total))
            top.append({"ts": ts, "kw": round(total * 4, 3), "meters": {m: round(v * 4, 3) for m, v in per.items()}})
        peaks = month_peaks(rows)
        months = sorted(peaks)
        cur = now.strftime("%Y-%m")
        top_month = sorted((t for t in top if dt_util.as_local(dt_util.utc_from_timestamp(t["ts"])).strftime("%Y-%m") == cur),
                           key=lambda t: -t["kw"])[:10]
        first = await self.hass.async_add_executor_job(self.db.first)
        return {"months": [{"month": m, **peaks[m]} for m in months], "billing_peak": billing_peak(months, peaks),
                "top": top_month, "since": first, "meters": self._meta()}
