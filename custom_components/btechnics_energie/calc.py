"""Rekenwerk zonder Home Assistant: tarieven, kwartieren, pieken. Makkelijk te testen."""
from __future__ import annotations

from bisect import bisect_right
from datetime import date

from .const import BILLING_MONTHS, MIN_MONTH_PEAK_KW


class Tariffs:
    """Vast tarief met historiek: elk tarief geldt vanaf een datum (00u00 lokale tijd)
    tot het volgende. Voor de eerste datum geldt het eerste tarief."""

    def __init__(self, items: list):
        self.items = sorted(({"from": str(i["from"]), "price": float(i["price"])} for i in items), key=lambda i: i["from"])
        self._keys = [i["from"] for i in self.items]

    def price(self, day: str | date) -> float | None:
        if not self.items:
            return None
        d = day.isoformat() if isinstance(day, date) else str(day)
        i = bisect_right(self._keys, d) - 1
        return self.items[max(i, 0)]["price"]


def quarters_from_5min(rows_by_meter: dict, tz=None, states: dict | None = None) -> dict:
    """5-minuutstatistieken (change in kWh per sensor, per meter samengeteld) omzetten naar
    kwartieren: {start_ts_kwartier: {meter: kWh}}. Enkel volledige kwartieren (3 blokken).
    states (optioneel): {meter: {start_ts_5min: meterstand}}; dan wordt ook states_out gevuld
    met de meterstand op het einde van elk kwartier: {kwartier: {meter: stand}}."""
    buckets = {}
    for meter, rows in rows_by_meter.items():
        for start, kwh in rows:
            q = int(start) - int(start) % 900
            b = buckets.setdefault(q, {}).setdefault(meter, [0.0, set()])
            b[0] += kwh
            b[1].add(int(start))
    out = {}
    for q, meters in buckets.items():
        full = {m: round(v[0], 5) for m, v in meters.items() if len(v[1]) == 3}
        if full and len(full) == len(meters):
            out[q] = full
    if states is not None:
        quarter_states = {}
        for q in out:
            st = {m: states.get(m, {}).get(q + 600) for m in out[q]}
            if all(v is not None for v in st.values()):
                quarter_states[q] = st
        return out, quarter_states
    return out


def quarter_bounds(start: int, end: int) -> tuple:
    """Begin naar beneden en einde naar boven afronden op het kwartier."""
    return start - start % 900, end + (-end) % 900


def month_peaks(quarters: list) -> dict:
    """quarters: [(ts, local_month 'YYYY-MM', totaal_kWh)] -> {maand: {"kw", "ts"}}.
    Kwartiervermogen = kWh in het kwartier x 4."""
    out = {}
    for ts, month, kwh in quarters:
        kw = kwh * 4
        cur = out.get(month)
        if cur is None or kw > cur["kw"]:
            out[month] = {"kw": round(kw, 3), "ts": ts}
    return out


def billing_peak(months: list, peaks: dict) -> float | None:
    """Gemiddelde van de maandpieken van de laatste 12 maanden (elke maandpiek minstens 2,5 kW).
    months: lijst 'YYYY-MM' tot en met de huidige maand."""
    last = [m for m in months if m in peaks][-BILLING_MONTHS:]
    if not last:
        return None
    return round(sum(max(peaks[m]["kw"], MIN_MONTH_PEAK_KW) for m in last) / len(last), 3)
