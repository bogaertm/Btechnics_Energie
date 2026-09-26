"""PDF-afrekening van het elektriciteitsverbruik van een evenement (fpdf2, standaardlettertype Helvetica
met Windows-1252, zodat euroteken en accenten werken zonder extra lettertypebestanden)."""
from __future__ import annotations

from datetime import datetime

DAYS = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"]
MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]

SENDER = ("TrefpuntFestival vzw", "Walter De Buckplein 5", "9000 Gent", "BE 0680 437 479")
DARK = (33, 33, 33)
GREY = (110, 110, 110)
LINE = (200, 200, 200)
FILL = (243, 243, 243)


def nl_num(v: float, d: int = 2) -> str:
    s = f"{v:,.{d}f}"
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def eur(v: float, d: int = 2) -> str:
    return f"€ {nl_num(v, d)}"


def when(dt: datetime) -> str:
    return f"{DAYS[dt.weekday()]} {dt.day} {MONTHS[dt.month - 1]} {dt.year}, {dt.hour:02d}u{dt.minute:02d}"


def day(dt: datetime) -> str:
    return f"{DAYS[dt.weekday()]} {dt.day} {MONTHS[dt.month - 1]} {dt.year}"


def build_pdf(report: dict, local, created: datetime) -> bytes:
    """report: uitkomst van Energy.event_report; local: functie epoch -> lokale datetime."""
    from fpdf import FPDF

    ev = report["event"]
    doc_name = f"Afrekening elektriciteit {ev.get('number', '')}".strip()

    class Doc(FPDF):
        def footer(self):
            self.set_y(-14)
            self.set_draw_color(*LINE)
            self.line(self.l_margin, self.get_y(), self.w - self.r_margin, self.get_y())
            self.set_font("Helvetica", size=8)
            self.set_text_color(*GREY)
            w = (self.w - self.l_margin - self.r_margin) / 3
            self.cell(w, 6, doc_name, align="L")
            self.cell(w, 6, day(created), align="C")
            self.cell(w, 6, f"Pagina {self.page_no()} van {{nb}}", align="R")

    pdf = Doc(format="A4", unit="mm")
    pdf.core_fonts_encoding = "windows-1252"
    pdf.set_margins(18, 16, 18)
    pdf.set_auto_page_break(True, margin=22)
    pdf.set_title(doc_name)
    pdf.set_author(SENDER[0])
    pdf.alias_nb_pages()
    pdf.add_page()
    W = pdf.w - pdf.l_margin - pdf.r_margin

    # briefhoofd
    pdf.set_text_color(*DARK)
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(W / 2, 6, SENDER[0], new_x="LEFT", new_y="NEXT")
    pdf.set_font("Helvetica", size=9.5)
    pdf.set_text_color(*GREY)
    for line in SENDER[1:]:
        pdf.cell(W / 2, 4.6, line, new_x="LEFT", new_y="NEXT")
    top = 16
    pdf.set_xy(pdf.l_margin + W / 2, top)
    pdf.set_text_color(*DARK)
    pdf.set_font("Helvetica", "B", 15)
    pdf.cell(W / 2, 7, "Afrekening elektriciteit", align="R", new_x="LEFT", new_y="NEXT")
    pdf.set_font("Helvetica", size=9.5)
    pdf.set_text_color(*GREY)
    pdf.set_x(pdf.l_margin + W / 2)
    pdf.cell(W / 2, 4.6, f"Referentie {ev.get('number', '')}", align="R", new_x="LEFT", new_y="NEXT")
    pdf.set_x(pdf.l_margin + W / 2)
    pdf.cell(W / 2, 4.6, f"Datum {day(created)}", align="R", new_x="LEFT", new_y="NEXT")
    pdf.set_y(top + 26)
    pdf.set_draw_color(*LINE)
    pdf.line(pdf.l_margin, pdf.get_y(), pdf.l_margin + W, pdf.get_y())
    pdf.ln(7)

    # evenement
    pdf.set_text_color(*DARK)
    pdf.set_font("Helvetica", "B", 16)
    pdf.multi_cell(W, 8, ev.get("name") or "Evenement", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)
    start, end = local(report["from"]), local(report["to"])
    real_start = datetime.fromisoformat(ev["start"])
    real_end = datetime.fromisoformat(ev["end"])
    mins = int((report["to"] - report["from"]) / 60)
    rows = [
        ("Organisator", ev.get("organizer") or "-"),
        ("Contact", ev.get("contact") or "-"),
        ("Periode", f"{when(real_start)} tot {when(real_end)}"),
        ("Gemeten", f"{when(start)} tot {when(end)} ({mins // 60}u{mins % 60:02d}), afgerond op het {report['resolution']}"),
        ("Locatie", ", ".join(m["name"] for m in report["meters"])),
    ]
    for label, value in rows:
        pdf.set_font("Helvetica", size=10)
        pdf.set_text_color(*GREY)
        pdf.cell(34, 6.2, label)
        pdf.set_text_color(*DARK)
        pdf.multi_cell(W - 34, 6.2, value, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(5)

    # tabel per meter
    cols = [W * 0.37, W * 0.21, W * 0.21, W * 0.21]
    pdf.set_font("Helvetica", "B", 9.5)
    pdf.set_fill_color(*FILL)
    pdf.set_text_color(*DARK)
    for i, h in enumerate(("Meter", "Meterstand begin", "Meterstand einde", "Verbruik")):
        pdf.cell(cols[i], 8, h, fill=True, align="L" if i == 0 else "R")
    pdf.ln()
    pdf.set_font("Helvetica", size=10)
    for m in report["meters"]:
        pdf.cell(cols[0], 8, m["name"])
        pdf.cell(cols[1], 8, f"{nl_num(m['begin'], 2)} kWh" if m.get("begin") is not None else "-", align="R")
        pdf.cell(cols[2], 8, f"{nl_num(m['end'], 2)} kWh" if m.get("end") is not None else "-", align="R")
        pdf.cell(cols[3], 8, f"{nl_num(m['kwh'], 2)} kWh", align="R")
        pdf.ln()
        pdf.set_draw_color(*LINE)
        pdf.line(pdf.l_margin, pdf.get_y(), pdf.l_margin + W, pdf.get_y())
    pdf.ln(6)

    # totaal
    x0 = pdf.l_margin + W * 0.46
    lw, vw = W * 0.30, W * 0.24
    def tot(label, value, bold=False):
        pdf.set_x(x0)
        pdf.set_font("Helvetica", "B" if bold else "", 11 if bold else 10)
        pdf.set_text_color(*(DARK if bold else GREY))
        pdf.cell(lw, 7, label)
        pdf.set_text_color(*DARK)
        pdf.cell(vw, 7, value, align="R", new_x="LMARGIN", new_y="NEXT")
    tot("Totaal verbruik", f"{nl_num(report['total'], 2)} kWh")
    if report.get("price") is not None:
        tot("Prijs per kWh", eur(report["price"], 4))
        pdf.set_draw_color(*DARK)
        pdf.line(x0, pdf.get_y() + 1, pdf.l_margin + W, pdf.get_y() + 1)
        pdf.ln(2)
        tot("Te betalen", eur(report["amount"]), bold=True)
    pdf.ln(6)

    note = (ev.get("note") or "").strip()
    pdf.set_font("Helvetica", size=9)
    pdf.set_text_color(*GREY)
    if note:
        pdf.set_text_color(*DARK)
        pdf.set_font("Helvetica", size=10)
        pdf.multi_cell(W, 5.4, note, new_x="LMARGIN", new_y="NEXT")
        pdf.ln(3)
        pdf.set_font("Helvetica", size=9)
        pdf.set_text_color(*GREY)
    method = ("Gemeten met de energiemeters van TrefpuntFestival vzw. Het verbruik is de som van de kwartierwaarden "
              "tussen begin en einde, afgerond op het volle kwartier.") if report["resolution"] == "kwartier" else (
              "Gemeten met de energiemeters van TrefpuntFestival vzw, per uur (voor deze periode zijn geen kwartierwaarden "
              "beschikbaar); begin en einde zijn afgerond op het volle uur.")
    pdf.multi_cell(W, 4.6, method, new_x="LMARGIN", new_y="NEXT")

    # handtekeningen
    if pdf.get_y() > pdf.h - 80:
        pdf.add_page()
    pdf.ln(12)
    bw = (W - 10) / 2
    y = pdf.get_y()
    for i, title in enumerate(("Voor TrefpuntFestival vzw", "Voor akkoord, de organisator")):
        x = pdf.l_margin + i * (bw + 10)
        pdf.set_xy(x, y)
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_text_color(*DARK)
        pdf.cell(bw, 6, title)
        pdf.set_font("Helvetica", size=9)
        pdf.set_text_color(*GREY)
        for j, lab in enumerate(("Naam", "Datum", "Handtekening")):
            yy = y + 14 + j * 11
            pdf.set_xy(x, yy - 5)
            pdf.cell(bw, 5, lab)
            pdf.set_draw_color(*LINE)
            pdf.line(x + 26, yy, x + bw, yy)
    return bytes(pdf.output())
