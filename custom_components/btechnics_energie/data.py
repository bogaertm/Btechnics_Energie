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

from .calc import Tariffs, billing_peak, gap_quarters, month_peaks, quarter_bounds, quarters_from_5min, spread_gaps
from .const import STORE_KEY, STORE_VERSION
from .events import EventStore
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
            # v0.2: meterstand (kWh, som van de fasen) op het einde van het kwartier
            cols = {r[1] for r in c.execute("PRAGMA table_info(quarter)")}
            if "state" not in cols:
                c.execute("ALTER TABLE quarter ADD COLUMN state REAL")
            # v0.3: 1 = kwartier direct na een gat in de gegevens (telt niet mee voor pieken)
            if "gap" not in cols:
                c.execute("ALTER TABLE quarter ADD COLUMN gap INTEGER")

    def _conn(self):
        return sqlite3.connect(self._path, timeout=30)

    def upsert(self, quarters: dict, states: dict | None = None, gaps: dict | None = None) -> int:
        states, gaps = states or {}, gaps or {}
        rows = [(m, int(ts), float(k), (states.get(ts) or {}).get(m), gaps.get(ts))
                for ts, per in quarters.items() for m, k in per.items()]
        if not rows:
            return 0
        with self._lock, closing(self._conn()) as c, c:
            c.executemany("INSERT INTO quarter (meter, ts, kwh, state, gap) VALUES (?, ?, ?, ?, ?) "
                          "ON CONFLICT(meter, ts) DO UPDATE SET kwh = excluded.kwh, state = COALESCE(excluded.state, state), "
                          "gap = COALESCE(excluded.gap, gap)", rows)
        return len(rows)

    def gaps(self, start: int, end: int) -> set:
        """Kwartieren direct na een gat in de gegevens (start <= ts < end)."""
        with closing(self._conn()) as c:
            return {r[0] for r in c.execute("SELECT DISTINCT ts FROM quarter WHERE ts >= ? AND ts < ? AND gap = 1", (start, end))}

    def last(self):
        with closing(self._conn()) as c:
            return c.execute("SELECT MAX(ts) FROM quarter").fetchone()[0]

    def states(self, start: int, end: int) -> dict:
        """{ts: {meter: meterstand}} op het einde van elk kwartier (start <= ts < end)."""
        out = {}
        with closing(self._conn()) as c:
            for m, ts, st in c.execute("SELECT meter, ts, state FROM quarter WHERE ts >= ? AND ts < ? AND state IS NOT NULL",
                                       (start, end)):
                out.setdefault(ts, {})[m] = st
        return out

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
        self.events = EventStore(hass)

    # ---------- tarieven ----------
    async def load(self):
        data = await self.store.async_load() or {}
        self.tariff_items = data.get("items", [])
        await self.events.load()

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

    async def _energy(self, start: datetime, end: datetime, period: str, with_state: bool = False):
        """{meter: {start_ts: kWh}} (som van de fasen) en {entity: {start_ts: kWh}} per fase.
        with_state: ook {meter: {start_ts: meterstand}} (som van de fasen, kWh)."""
        per_meter = self._energy_ids()
        ids = [e for v in per_meter.values() for e in v]
        rows = await self._stats(ids, start, end, period, {"change", "state"} if with_state else {"change"}, {"energy": "kWh"})
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
        if with_state:
            states = {}
            for mid, ents in per_meter.items():
                per_ts = {}
                for e in ents:
                    for r in rows.get(e, []):
                        if r.get("state") is not None and s_ts <= r["start"] < e_ts:
                            per_ts.setdefault(int(r["start"]), []).append(r["state"])
                states[mid] = {ts: round(sum(v), 4) for ts, v in per_ts.items() if len(v) == len(ents)}
            return meters, by_ent, states
        return meters, by_ent

    async def _hourly(self, start: datetime, end: datetime):
        """Uurverbruik per meter en per fase, met opgevulde onderbrekingen (zie calc.spread_gaps).
        Haalt ook uren voor en na de periode op, zodat een gat aan de rand juist verdeeld wordt.
        Geeft ({meter: {ts: kWh}}, {entity: {ts: kWh}}, {ts geschat})."""
        now = dt_util.utcnow()
        fs = start - timedelta(days=2)
        fe = min(end + timedelta(days=7, hours=1), now + timedelta(hours=1))
        if fe <= start:
            fe = end
        _, by_ent = await self._energy(fs, max(fe, end), "hour")
        s_ts, e_ts = start.timestamp(), end.timestamp()
        est_all = set()
        ents = {}
        for e, ser in by_ent.items():
            full, est = spread_gaps(ser)
            ents[e] = {ts: v for ts, v in full.items() if s_ts <= ts < e_ts}
            est_all |= {ts for ts in est if s_ts <= ts < e_ts}
        meters = {}
        for mid, ids in self._energy_ids().items():
            acc = {}
            for e in ids:
                for ts, v in ents.get(e, {}).items():
                    acc[ts] = acc.get(ts, 0.0) + v
            meters[mid] = acc
        return meters, ents, est_all

    # ---------- kwartieren ----------
    async def import_quarters(self, hours: int = 3) -> int:
        """Volledige kwartieren uit de 5-minuutstatistieken overnemen (dubbel overnemen kan geen kwaad)."""
        end = dt_util.utcnow()
        start = end - timedelta(hours=hours)
        meters, _, states = await self._energy(start, end, "5minute", with_state=True)
        rows = {m: list(v.items()) for m, v in meters.items()}
        q, qs = quarters_from_5min(rows, None, states)
        # enkel kwartieren waarvoor alle meters gegevens hebben
        q = {ts: per for ts, per in q.items() if len(per) == len(self.meters)}
        gaps = gap_quarters(rows, q, int(start.timestamp()) + 300)
        return await self.hass.async_add_executor_job(self.db.upsert, q, qs, gaps)

    # ---------- hulp ----------
    @staticmethod
    def _local_midnight(d: date) -> datetime:
        return dt_util.start_of_local_day(d)

    @staticmethod
    def _local_day(ts: float) -> str:
        return dt_util.as_local(dt_util.utc_from_timestamp(ts)).date().isoformat()

    def _sel(self, meters) -> list:
        """Gekozen meter-ids (alle als niets of iets onbekends gekozen is)."""
        ids = [m["id"] for m in self.meters]
        chosen = [m for m in (meters or []) if m in ids]
        return chosen or ids

    def _meta(self, sel=None):
        return [{"id": m["id"], "name": m["name"],
                 "power": {str(p): e for p, e in m["ents"]["power"].items()},
                 "current": {str(p): e for p, e in m["ents"]["current"].items()},
                 "voltage": {str(p): e for p, e in m["ents"]["voltage"].items()}} for m in self.meters
                if sel is None or m["id"] in sel]

    # ---------- per dag ----------
    async def days(self, start: date, end: date, meters_sel=None) -> dict:
        """Per dag (lokale tijd, start en end inbegrepen): kWh per meter, totaal, tarief, kost, kwartierpiek.
        meters_sel: enkel deze meters (totaal en piek over de gekozen meters)."""
        sel = self._sel(meters_sel)
        s, e = self._local_midnight(start), self._local_midnight(end + timedelta(days=1))
        # per uur (met opgevulde onderbrekingen) en dan per lokale dag, zodat het inhaalverbruik na een
        # onderbreking bij de juiste dag komt
        hourly, _, est = await self._hourly(s, e)
        meters = {}
        for mid, per in hourly.items():
            if mid not in sel:
                continue
            acc = {}
            for ts, k in per.items():
                d = self._local_day(ts)
                acc[d] = acc.get(d, 0.0) + k
            meters[mid] = acc
        est_days = {self._local_day(ts) for ts in est}
        quarters = await self.hass.async_add_executor_job(self.db.between, int(s.timestamp()), int(e.timestamp()))
        gaps = await self.hass.async_add_executor_job(self.db.gaps, int(s.timestamp()), int(e.timestamp()))
        peaks = {}
        for ts, per in quarters.items():
            if ts in gaps or not all(m in per for m in sel):
                continue
            d = self._local_day(ts)
            kw = sum(per[m] for m in sel) * 4
            if d not in peaks or kw > peaks[d]["kw"]:
                peaks[d] = {"kw": round(kw, 3), "ts": ts}
        t = self.tariffs
        out, days = [], {}
        for mid, per in meters.items():
            for d, k in per.items():
                days.setdefault(d, {})[mid] = k
        for d in sorted(days):
            per = days[d]
            total = sum(per.values())
            price = t.price(d)
            out.append({"date": d, "meters": {m: round(v, 3) for m, v in per.items()}, "total": round(total, 3),
                        "price": price, "cost": round(total * price, 4) if price is not None else None,
                        "peak": peaks.get(d), **({"estimated": True} if d in est_days else {})})
        return {"days": out, "meters": self._meta(sel), "all_meters": self._meta(), "tariffs": self.tariff_items}

    # ---------- een dag in detail ----------
    async def day(self, d: date) -> dict:
        s, e = self._local_midnight(d), self._local_midnight(d + timedelta(days=1))
        meters, by_ent, est = await self._hourly(s, e)
        hours = {}
        for mid, per in meters.items():
            for ts, k in per.items():
                hours.setdefault(ts, {})[mid] = round(k, 4)
        quarters = await self.hass.async_add_executor_job(self.db.between, int(s.timestamp()), int(e.timestamp()))
        gaps = await self.hass.async_add_executor_job(self.db.gaps, int(s.timestamp()), int(e.timestamp()))
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
                "hours": [{"ts": ts, "meters": per, **({"estimated": True} if ts in est else {})} for ts, per in sorted(hours.items())],
                "quarters": [{"ts": ts, "meters": per, **({"gap": True} if ts in gaps else {})} for ts, per in sorted(quarters.items())],
                "phase_period": period, "phases": phases, "meters": self._meta()}

    # ---------- pieken per maand ----------
    async def peaks(self, meters_sel=None) -> dict:
        sel = self._sel(meters_sel)
        now = dt_util.now()
        start = int((now - timedelta(days=400)).timestamp())
        quarters = await self.hass.async_add_executor_job(self.db.between, start, int(now.timestamp()) + 900)
        gaps = await self.hass.async_add_executor_job(self.db.gaps, start, int(now.timestamp()) + 900)
        rows = []
        top = []
        for ts, per in quarters.items():
            if ts in gaps or not all(m in per for m in sel):
                continue
            local = dt_util.as_local(dt_util.utc_from_timestamp(ts))
            total = sum(per[m] for m in sel)
            rows.append((ts, local.strftime("%Y-%m"), total))
            top.append({"ts": ts, "kw": round(total * 4, 3), "meters": {m: round(per[m] * 4, 3) for m in sel}})
        peaks = month_peaks(rows)
        months = sorted(peaks)
        cur = now.strftime("%Y-%m")
        top_month = sorted((t for t in top if dt_util.as_local(dt_util.utc_from_timestamp(t["ts"])).strftime("%Y-%m") == cur),
                           key=lambda t: -t["kw"])[:10]
        first = await self.hass.async_add_executor_job(self.db.first)
        return {"months": [{"month": m, **peaks[m]} for m in months], "billing_peak": billing_peak(months, peaks),
                "top": top_month, "since": first, "meters": self._meta(sel), "all_meters": self._meta()}


    # ---------- evenementen ----------
    async def event_report(self, ev: dict) -> dict:
        """Verbruik van een evenement per kwartier (begin en einde afgerond op het kwartier), met de
        meterstanden bij begin en einde.

        - Nog niet begonnen: niets gemeten (not_started). Loopt het nog: gemeten tot het laatste kwartier
          dat al overgenomen is (de kwartieren komen elke 5 minuten binnen), met ongoing.
        - Ontbreekt een kwartier (Home Assistant stond even uit), dan wordt het geschat uit de uurstatistiek:
          het verbruik van dat uur min de gekende kwartieren van dat uur, verdeeld over de ontbrekende
          kwartieren. Ook aan de randen van het evenement. Zo'n uur staat in estimated_hours.
        - Zonder kwartieren (voor de integratie bestond) per uur, begin en einde op het uur; uren zonder
          gegevens staan in missing_hours.
        Meterstanden: uit de kwartieren, anders uit de uurstatistieken (stand op het einde van het uur)."""
        ids = [m["id"] for m in self.meters]
        unknown = [m for m in (ev.get("meters") or []) if m not in ids]
        sel = [m for m in (ev.get("meters") or []) if m in ids]
        if unknown or not sel:
            raise ValueError("meter van dit evenement bestaat niet meer (" + ", ".join(unknown or ["geen meter"])
                             + "): open het evenement en kies de meters opnieuw")
        start = int(dt_util.parse_datetime(ev["start"]).timestamp())
        end = int(dt_util.parse_datetime(ev["end"]).timestamp())
        now = int(dt_util.utcnow().timestamp())
        qs, qe = quarter_bounds(start, end)
        not_started = start > now
        ongoing = False
        if not not_started:
            last = await self.hass.async_add_executor_job(self.db.last)
            # tot het laatste overgenomen kwartier (hoogstens 30 min terug; anders tot het laatste volle kwartier)
            limit = now - now % 900
            if last is not None and limit - (last + 900) <= 1800:
                limit = min(limit, last + 900)
            if qe > limit:
                ongoing = True
                qe = max(qs, limit)
        else:
            qe = qs
        hs = qs - qs % 3600
        he = qe + (-qe) % 3600
        quarters = await self.hass.async_add_executor_job(self.db.between, hs, he)
        gaps = await self.hass.async_add_executor_job(self.db.gaps, qs, qe)
        qstates = await self.hass.async_add_executor_job(self.db.states, qs - 900, qe)
        have_q = any(all(m in quarters.get(ts, {}) for m in sel) for ts in range(qs, qe, 900))

        # uurstatistieken (verbruik en stand) rond de periode: nodig voor ontbrekende kwartieren en meterstanden
        hmeters, _, hstates = await self._energy(dt_util.utc_from_timestamp(hs - 3600), dt_util.utc_from_timestamp(max(he, hs + 3600)),
                                                 "hour", with_state=True)

        per_meter = {m: 0.0 for m in sel}
        series, estimated, missing_hours = [], set(), set()
        if have_q or qe == qs:
            resolution, step = "kwartier", 900
            for ts in range(qs, qe, 900):
                h = ts - ts % 3600
                per, est = {}, False
                for m in sel:
                    v = quarters.get(ts, {}).get(m)
                    if v is None:
                        hv = hmeters.get(m, {}).get(h)
                        if hv is None:
                            missing_hours.add(h)
                            v = 0.0
                        else:
                            known = [quarters.get(t, {}).get(m) for t in range(h, h + 3600, 900)]
                            n_missing = sum(1 for x in known if x is None)
                            v = max(0.0, (hv - sum(x for x in known if x is not None)) / max(1, n_missing))
                            estimated.add(h)
                        est = True
                    per[m] = v
                    per_meter[m] += v
                series.append({"ts": ts, "meters": per, **({"estimated": True} if est else {}),
                               **({"gap": True} if ts in gaps else {})})
            f, t = qs, qe
        else:
            resolution, step = "uur", 3600
            f = start - start % 3600
            t = end + (-end) % 3600
            if ongoing:
                t = max(f, now - now % 3600)
            for ts in range(f, t, 3600):
                per = {m: hmeters.get(m, {}).get(ts) for m in sel}
                if any(v is None for v in per.values()):
                    missing_hours.add(ts)
                per = {m: v for m, v in per.items() if v is not None}
                for m, v in per.items():
                    per_meter[m] += v
                series.append({"ts": ts, "meters": per})

        def reading(m, at):
            q = (qstates.get(at - 900) or {}).get(m)
            if q is not None:
                return q
            if at % 3600 == 0:
                return hstates.get(m, {}).get(at - 3600)
            return None

        total = sum(per_meter.values())
        price = ev.get("price")
        if price is None:
            price = self.tariffs.price(dt_util.as_local(dt_util.utc_from_timestamp(start)).date())
        peak = None
        if resolution == "kwartier":
            for x in series:
                if x.get("estimated") or x.get("gap"):
                    continue
                kw = sum(x["meters"].values()) * 4
                if peak is None or kw > peak["kw"]:
                    peak = {"kw": round(kw, 3), "ts": x["ts"]}
        names = {m["id"]: m["name"] for m in self.meters}
        return {
            "event": ev, "from": f, "to": t, "resolution": resolution, "step": step, "ongoing": ongoing,
            "not_started": not_started, "estimated_hours": sorted(estimated), "missing_hours": sorted(missing_hours),
            "meters": [{"id": m, "name": names.get(m, m), "kwh": round(per_meter[m], 3),
                        "begin": None if not_started else reading(m, f), "end": None if not_started else reading(m, t)} for m in sel],
            "total": round(total, 3), "price": price, "amount": round(total * price, 2) if price is not None else None,
            "peak": peak, "series": series,
        }
