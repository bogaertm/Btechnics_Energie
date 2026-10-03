from custom_components.btechnics_energie.calc import Tariffs, billing_peak, month_peaks, quarters_from_5min


def test_tarief_met_historiek():
    t = Tariffs([{"from": "2026-10-01", "price": 0.30}, {"from": "2000-01-01", "price": 0.36}])
    assert t.price("2026-09-30") == 0.36 and t.price("2026-10-01") == 0.30 and t.price("1999-01-01") == 0.36
    assert Tariffs([]).price("2026-01-01") is None


def test_kwartieren_enkel_volledig():
    q0 = 1790409600          # veelvoud van 900
    rows = {"voor": [(q0, 0.1), (q0 + 300, 0.2), (q0 + 600, 0.3), (q0 + 900, 0.5)],
            "achter": [(q0, 1.0), (q0 + 300, 1.0), (q0 + 600, 1.0)]}
    q = quarters_from_5min(rows, None)
    assert q == {q0: {"voor": 0.6, "achter": 3.0}}     # tweede kwartier onvolledig


def test_maandpiek_en_facturatiepiek():
    peaks = month_peaks([(1, "2026-08", 0.5), (2, "2026-09", 1.2), (3, "2026-09", 0.9)])
    assert peaks == {"2026-08": {"kw": 2.0, "ts": 1}, "2026-09": {"kw": 4.8, "ts": 2}}
    # augustus 2,0 kW telt als het minimum 2,5 kW
    assert billing_peak(["2026-08", "2026-09"], peaks) == 3.65
    assert billing_peak([], {}) is None


def test_onderbreking_verdeeld_over_de_ontbrekende_uren():
    from custom_components.btechnics_energie.calc import spread_gaps
    H = 3600
    # 3 uur gegevens, 4 uur onbereikbaar, dan 1 uur met het hele inhaalverbruik (10 kWh)
    ser = {0: 1.0, H: 1.0, 2 * H: 1.0, 7 * H: 10.0, 8 * H: 1.0}
    out, est = spread_gaps(ser)
    assert [out[i * H] for i in range(3, 8)] == [2.0] * 5          # 10 kWh over 5 uren (4 ontbrekend + inhaaluur)
    assert est == {i * H for i in range(3, 8)}
    assert abs(sum(out.values()) - sum(ser.values())) < 1e-9      # totaal blijft gelijk
    assert spread_gaps({0: 1.0, H: 2.0})[1] == set()                # geen gat: niets geschat
    long = {0: 1.0, 200 * H: 50.0}
    assert spread_gaps(long)[0] == long                              # gat langer dan 7 dagen: niet raden
