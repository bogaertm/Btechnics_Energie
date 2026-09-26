"""Integratie met de echte recorder: dagen, dag in detail, tarieven, kwartieren en pieken."""
from datetime import datetime, timedelta, timezone

import pytest
from homeassistant.components.recorder.models import StatisticMeanType
from homeassistant.components.recorder.statistics import async_import_statistics
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.components.recorder.common import async_wait_recording_done

from custom_components.btechnics_energie.const import DOMAIN

METERS = ("voorbouw", "achterbouw")


def make_meter(hass, name):
    entry = MockConfigEntry(domain="shelly_test")
    entry.add_to_hass(hass)
    dev = dr.async_get(hass).async_get_or_create(config_entry_id=entry.entry_id, identifiers={("t", name)}, name=f"Energiemeter {name}")
    ent = er.async_get(hass)
    ids = {}
    for kind, dc in (("energy", "energy"), ("energy_returned", "energy"), ("power", "power"), ("voltage", "voltage"), ("current", "current")):
        for suf in ("", "_2", "_3"):
            e = ent.async_get_or_create("sensor", "shelly_test", f"{name}_{kind}{suf}", device_id=dev.id,
                                        suggested_object_id=f"{name}_{kind}{suf}", original_device_class=dc)
            ids[f"{kind}{suf}"] = e.entity_id
    return dev.id, ids


def import_hours(hass, entity_id, start, kwh_per_hour, hours, unit="Wh"):
    factor = 1000 if unit == "Wh" else 1
    meta = {"has_sum": True, "mean_type": StatisticMeanType.NONE, "name": None, "source": "recorder",
            "statistic_id": entity_id, "unit_class": "energy", "unit_of_measurement": unit}
    total, stats = 0.0, []
    for h in range(hours):
        total += kwh_per_hour * factor
        stats.append({"start": start + timedelta(hours=h), "state": total, "sum": total})
    async_import_statistics(hass, meta, stats)


@pytest.fixture
async def setup(hass, recorder_mock, hass_ws_client):
    await hass.config.async_set_time_zone("Europe/Brussels")
    meters = {m: make_meter(hass, m) for m in METERS}
    hass.states.async_set("input_number.energietarief_per_kwh", "0.36")
    # 3 dagen: voorbouw 1 kWh per uur per fase (3 kWh/u), achterbouw 0,5 kWh per uur op fase 1
    start = dt_util.start_of_local_day(dt_util.now().date() - timedelta(days=3)).astimezone(timezone.utc)
    for p in ("", "_2", "_3"):
        import_hours(hass, meters["voorbouw"][1][f"energy{p}"], start, 1.0, 72)
    import_hours(hass, meters["achterbouw"][1]["energy"], start, 0.5, 72, unit="kWh")
    import_hours(hass, meters["achterbouw"][1]["energy_2"], start, 0.0, 72)
    import_hours(hass, meters["achterbouw"][1]["energy_3"], start, 0.0, 72)
    await async_wait_recording_done(hass)
    entry = MockConfigEntry(domain=DOMAIN, data={"meters": [
        {"id": m, "name": m.capitalize(), "device_id": meters[m][0]} for m in METERS]})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    c = await hass_ws_client(hass)

    async def ws(**kw):
        await c.send_json_auto_id(kw)
        return await c.receive_json()

    return {"ws": ws, "start": start, "meters": meters, "entry": entry}


async def test_dagen_met_kost(hass, setup):
    ws = setup["ws"]
    d0 = (dt_util.now().date() - timedelta(days=3)).isoformat()
    d2 = (dt_util.now().date() - timedelta(days=1)).isoformat()
    r = await ws(type=f"{DOMAIN}/days", start=d0, end=d2)
    assert r["success"], r
    days = r["result"]["days"]
    assert [d["date"] for d in days] == [d0, (dt_util.now().date() - timedelta(days=2)).isoformat(), d2]
    # een enkele dag geeft precies die dag (de recorder geeft ook de rij van de volgende dag terug)
    r1 = await ws(type=f"{DOMAIN}/days", start=d0, end=d0)
    assert [d["date"] for d in r1["result"]["days"]] == [d0]
    # eerste dag: 24 uur, maar het eerste uur heeft geen "change" (geen vorige som)
    full = days[1]
    assert full["meters"] == {"voorbouw": 72.0, "achterbouw": 12.0} and full["total"] == 84.0
    assert full["price"] == 0.36 and full["cost"] == pytest.approx(84 * 0.36)
    assert [m["id"] for m in r["result"]["meters"]] == ["voorbouw", "achterbouw"]
    assert r["result"]["meters"][0]["power"]["1"].startswith("sensor.voorbouw_power")


async def test_tarief_historiek_en_rechten(hass, setup, hass_ws_client, hass_read_only_access_token):
    ws = setup["ws"]
    d1 = (dt_util.now().date() - timedelta(days=1)).isoformat()
    r = await ws(type=f"{DOMAIN}/tariff/set", **{"from": d1, "price": 0.30})
    assert r["success"] and [t["from"] for t in r["result"]["tariffs"]] == ["2000-01-01", d1]
    r = await ws(type=f"{DOMAIN}/days", start=(dt_util.now().date() - timedelta(days=2)).isoformat(), end=d1)
    prices = [d["price"] for d in r["result"]["days"]]
    assert prices == [0.36, 0.30]
    ro = await hass_ws_client(hass, hass_read_only_access_token)
    await ro.send_json_auto_id({"type": f"{DOMAIN}/tariff/set", "from": d1, "price": 1})
    assert not (await ro.receive_json())["success"]
    await ro.send_json_auto_id({"type": f"{DOMAIN}/days", "start": d1, "end": d1})
    assert (await ro.receive_json())["success"]          # lezen mag voor iedereen
    r = await ws(type=f"{DOMAIN}/tariff/delete", **{"from": d1})
    assert r["success"] and len(r["result"]["tariffs"]) == 1
    r = await ws(type=f"{DOMAIN}/tariff/delete", **{"from": "2000-01-01"})
    assert not r["success"]                              # minstens een tarief


async def test_dag_in_detail_en_pieken(hass, setup):
    from custom_components.btechnics_energie import data as data_mod
    ws = setup["ws"]
    en = hass.data[DOMAIN]
    d = dt_util.now().date() - timedelta(days=2)
    s = int(dt_util.start_of_local_day(d).timestamp())
    # kwartieren: rechtstreeks in de databank (5-minuutstatistieken kunnen niet geimporteerd worden)
    en.db.upsert({s + 900 * i: {"voorbouw": 0.75, "achterbouw": 0.125} for i in range(96)})
    en.db.upsert({s + 900 * 70: {"voorbouw": 2.0, "achterbouw": 0.5}})           # 10 kW om 17u30
    r = await ws(type=f"{DOMAIN}/day", date=d.isoformat())
    assert r["success"], r
    day = r["result"]
    assert len(day["hours"]) == 24 and all(day["start"] <= h["ts"] < day["end"] for h in day["hours"]) and day["hours"][5]["meters"] == {"voorbouw": 3.0, "achterbouw": 0.5}
    assert len(day["quarters"]) == 96 and day["price"] == 0.36
    assert set(day["phases"]["voorbouw"]) == {"1", "2", "3"} and day["phases"]["voorbouw"]["1"]["kwh"] == 24.0
    r = await ws(type=f"{DOMAIN}/days", start=d.isoformat(), end=d.isoformat())
    assert r["result"]["days"][0]["peak"] == {"kw": 10.0, "ts": s + 900 * 70}
    r = await ws(type=f"{DOMAIN}/peaks")
    month = dt_util.as_local(dt_util.utc_from_timestamp(s)).strftime("%Y-%m")
    assert {"month": month, "kw": 10.0, "ts": s + 900 * 70} in r["result"]["months"]
    assert r["result"]["billing_peak"] is not None


async def test_kwartieren_overnemen(hass, setup, monkeypatch):
    en = hass.data[DOMAIN]
    q0 = int(dt_util.utcnow().timestamp()) // 900 * 900 - 1800

    async def fake(start, end, period, with_state=False):
        assert period == "5minute" and with_state
        return ({"voorbouw": {q0: 0.1, q0 + 300: 0.1, q0 + 600: 0.1}, "achterbouw": {q0: 0.2, q0 + 300: 0.2, q0 + 600: 0.2}}, {},
                {"voorbouw": {q0 + 600: 100.3}, "achterbouw": {q0 + 600: 200.6}})
    monkeypatch.setattr(en, "_energy", fake)
    assert await en.import_quarters() == 2
    assert await en.import_quarters() == 2                  # nogmaals: geen dubbels
    assert en.db.between(q0, q0 + 1) == {q0: {"voorbouw": pytest.approx(0.3), "achterbouw": pytest.approx(0.6)}}
    assert en.db.states(q0, q0 + 1) == {q0: {"voorbouw": 100.3, "achterbouw": 200.6}}


async def test_eerste_tarief_uit_oude_helper(hass, setup):
    assert hass.data[DOMAIN].tariff_items == [{"from": "2000-01-01", "price": 0.36}]


async def test_config_flow(hass, recorder_mock):
    dev, _ = make_meter(hass, "voorbouw")
    r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert r["type"] == "form"
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"devices": []})
    assert r["errors"] == {"base": "no_meters"}
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"devices": [dev]})
    assert r["type"] == "create_entry" and r["data"]["meters"][0] == {"id": "voorbouw", "name": "voorbouw", "device_id": dev}


async def test_meters_apart(hass, setup):
    ws = setup["ws"]
    d = (dt_util.now().date() - timedelta(days=2)).isoformat()
    r = await ws(type=f"{DOMAIN}/days", start=d, end=d, meters=["achterbouw"])
    day = r["result"]["days"][0]
    assert day["meters"] == {"achterbouw": 12.0} and day["total"] == 12.0
    assert [m["id"] for m in r["result"]["meters"]] == ["achterbouw"] and len(r["result"]["all_meters"]) == 2


async def test_evenement_rapport_en_pdf(hass, setup, hass_client, hass_read_only_access_token, hass_ws_client):
    from homeassistant.setup import async_setup_component
    ws = setup["ws"]
    en = hass.data[DOMAIN]
    d = dt_util.now().date() - timedelta(days=2)
    s = int(dt_util.start_of_local_day(d).timestamp())
    # kwartieren van 18u00 tot 23u00 met meterstanden
    q = {s + 900 * i: {"voorbouw": 0.5, "achterbouw": 0.25} for i in range(96)}
    st = {s + 900 * i: {"voorbouw": 1000 + 0.5 * (i + 1), "achterbouw": 500 + 0.25 * (i + 1)} for i in range(96)}
    en.db.upsert(q, st)
    start = f"{d.isoformat()}T19:07"
    end = f"{d.isoformat()}T22:52"
    draft = {"name": "Optreden", "organizer": "Vzw Test", "start": start, "end": end, "meters": ["voorbouw"], "price": 0.45}
    r = await ws(type=f"{DOMAIN}/event/report", draft=draft)
    assert r["success"], r
    rep = r["result"]
    # 19u00 tot 23u00 = 16 kwartieren x 0,5 kWh = 8 kWh
    assert rep["resolution"] == "kwartier" and rep["total"] == 8.0 and rep["amount"] == 3.6
    m = rep["meters"][0]
    assert m["begin"] == 1000 + 0.5 * 76 and m["end"] == 1000 + 0.5 * 92 and m["end"] - m["begin"] == 8.0
    r = await ws(type=f"{DOMAIN}/event/save", **draft)
    assert r["success"] and r["result"]["event"]["number"].startswith("EV-")
    eid = r["result"]["event"]["id"]
    r = await ws(type=f"{DOMAIN}/events")
    assert r["result"]["events"][0]["total"] == 8.0
    # zonder eigen prijs: tarief van die dag
    r = await ws(type=f"{DOMAIN}/event/save", event_id=eid, **{**draft, "price": None})
    r = await ws(type=f"{DOMAIN}/event/report", event_id=eid)
    assert r["result"]["price"] == 0.36
    # einde voor begin: geweigerd
    r = await ws(type=f"{DOMAIN}/event/save", **{**draft, "end": f"{d.isoformat()}T18:00"})
    assert not r["success"]
    # PDF: beheerder wel, gewone gebruiker niet
    assert await async_setup_component(hass, "http", {})
    client = await hass_client()
    resp = await client.get(f"/api/btechnics_energie/evenement/{eid}/pdf")
    body = await resp.read()
    assert resp.status == 200 and body.startswith(b"%PDF") and resp.headers["Content-Type"] == "application/pdf"
    ro = await hass_client(hass_read_only_access_token)
    assert (await ro.get(f"/api/btechnics_energie/evenement/{eid}/pdf")).status == 403
    rows = await hass_ws_client(hass, hass_read_only_access_token)
    await rows.send_json_auto_id({"type": f"{DOMAIN}/events"})
    assert not (await rows.receive_json())["success"]
    r = await ws(type=f"{DOMAIN}/event/delete", event_id=eid)
    assert r["success"] and (await ws(type=f"{DOMAIN}/events"))["result"]["events"] == []
    r = await ws(type=f"{DOMAIN}/event/save", **draft)            # nummer van het verwijderde evenement opnieuw
    assert r["result"]["event"]["number"] == f"EV-{d.year}-001"


async def test_evenement_zonder_kwartieren_per_uur(hass, setup):
    ws = setup["ws"]
    d = dt_util.now().date() - timedelta(days=2)
    draft = {"name": "Expo", "start": f"{d.isoformat()}T10:20", "end": f"{d.isoformat()}T12:40", "meters": ["voorbouw", "achterbouw"]}
    r = await ws(type=f"{DOMAIN}/event/report", draft=draft)
    rep = r["result"]
    # 10u00 tot 13u00 per uur: 3 x (3 + 0,5) kWh
    assert rep["resolution"] == "uur" and rep["total"] == 10.5 and rep["price"] == 0.36
    # meterstanden uit de uurstatistieken: stand op 10u00 en op 13u00 (voorbouw: 3 fasen x 1 kWh per uur)
    v = rep["meters"][0]
    assert v["begin"] is not None and v["end"] - v["begin"] == pytest.approx(9.0)


async def test_evenement_dat_nog_loopt(hass, setup):
    ws = setup["ws"]
    en = hass.data[DOMAIN]
    now = int(dt_util.utcnow().timestamp())
    q_now = now - now % 900
    s = q_now - 8 * 900
    en.db.upsert({s + 900 * i: {"voorbouw": 0.5, "achterbouw": 0.25} for i in range(-1, 8)},
                 {s + 900 * i: {"voorbouw": 100 + 0.5 * (i + 1), "achterbouw": 50 + 0.25 * (i + 1)} for i in range(-1, 8)})
    loc = lambda ts: dt_util.as_local(dt_util.utc_from_timestamp(ts)).strftime("%Y-%m-%dT%H:%M")
    draft = {"name": "Loopt nog", "start": loc(s), "end": loc(now + 3 * 3600), "meters": ["voorbouw"]}
    rep = (await ws(type=f"{DOMAIN}/event/report", draft=draft))["result"]
    assert rep["ongoing"] and rep["resolution"] == "kwartier" and rep["to"] == q_now and rep["total"] == 4.0
    assert rep["meters"][0]["begin"] == 100.0 and rep["meters"][0]["end"] == 104.0


async def test_evenement_met_gat_in_kwartieren(hass, setup):
    """Een uur zonder kwartieren (Home Assistant uit) wordt aangevuld met de uurwaarde."""
    ws = setup["ws"]
    en = hass.data[DOMAIN]
    d = dt_util.now().date() - timedelta(days=2)
    s = int(dt_util.start_of_local_day(d).timestamp())
    en.db.upsert({s + 900 * i: {"voorbouw": 0.75, "achterbouw": 0.125} for i in range(96) if not 40 <= i < 44})   # 10u00-11u00 ontbreekt
    draft = {"name": "Gat", "start": f"{d.isoformat()}T09:00", "end": f"{d.isoformat()}T12:00", "meters": ["voorbouw"]}
    rep = (await ws(type=f"{DOMAIN}/event/report", draft=draft))["result"]
    assert rep["resolution"] == "kwartier" and len(rep["estimated_hours"]) == 1 and rep["total"] == pytest.approx(9.0)
