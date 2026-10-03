/*
 * Btechnics Energie: dashboardkaart custom:btechnics-energie
 *   Overzicht  nu, vandaag, week, maand, jaar met kost; laatste 30 dagen
 *   Dag        een dag in detail: per uur of kwartier, per fase, kost van die dag
 *   Periode    per dag, week of maand over een gekozen periode, met CSV
 *   Pieken     kwartierpiek per maand (capaciteitstarief)
 *   Tarieven   prijs per kWh met historiek
 * Zelfde stijl als de kaarten van Btechnics VTO. Tijden in de tijdzone van Home Assistant.
 */
// geschatte uren: een meter was even onbereikbaar; het inhaalverbruik is gelijk verdeeld over die uren
const EST_MARK = ' <span class="muted" title="Geschat: de meter was onbereikbaar, het verbruik van die periode is gelijk verdeeld">*</span>';
const EST_NOTE = "* Geschat: de meter was even onbereikbaar. Het verbruik van die periode (de meterstand liep gewoon door) is gelijk verdeeld over de ontbrekende uren; het totaal klopt.";
const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const MONTHS_LONG = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
const DAYS = ["Zo", "Ma", "Di", "Wo", "Do", "Vr", "Za"];
const DOMAIN = "btechnics_energie";

// categorische kleuren (gevalideerd palet, licht en donker), vaste volgorde: meter 1, meter 2, ...
const SERIES = { light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"], dark: ["#3987e5", "#d95926", "#199e70", "#c98500"] };

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function errText(e) {
  if (e && typeof e === "object" && e.message) return e.message;
  if (typeof e === "number" || !e) return "geen verbinding met Home Assistant";
  return String(e);
}

const two = (n) => String(n).padStart(2, "0");
const nf = (d) => new Intl.NumberFormat("nl-BE", { minimumFractionDigits: d, maximumFractionDigits: d });
const N0 = nf(0), N1 = nf(1), N2 = nf(2), N3 = nf(3);
const EUR = new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" });
const EUR4 = new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR", minimumFractionDigits: 4, maximumFractionDigits: 4 });
const kwh = (v, d = 1) => (v == null ? "-" : `${[N0, N1, N2, N3][d].format(v)} kWh`);
const eur = (v) => (v == null ? "-" : EUR.format(v));
const kw = (v) => (v == null ? "-" : `${N2.format(v)} kW`);

// Datums als "Za 13 sep 2026" en uren als "23u14"
function makeFmt(tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz || undefined, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const parts = (d) => {
    const p = {};
    for (const x of f.formatToParts(d)) if (x.type !== "literal") p[x.type] = Number(x.value);
    if (p.hour === 24) p.hour = 0;
    return p;
  };
  const iso = (p) => `${p.year}-${two(p.month)}-${two(p.day)}`;
  return {
    parts,
    isoOf: (ts) => iso(parts(new Date(ts * 1000))),
    time: (ts) => { const p = parts(new Date(ts * 1000)); return `${two(p.hour)}u${two(p.minute)}`; },
    dateTime: (ts) => { const p = parts(new Date(ts * 1000)); return `${dayLabel(iso(p))}, ${two(p.hour)}u${two(p.minute)}`; },
  };
}

// kalenderdatums ("YYYY-MM-DD") rekenen zonder tijdzones
const D = {
  parse: (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); },
  str: (dt) => `${dt.getUTCFullYear()}-${two(dt.getUTCMonth() + 1)}-${two(dt.getUTCDate())}`,
  add: (s, n) => { const dt = D.parse(s); dt.setUTCDate(dt.getUTCDate() + n); return D.str(dt); },
  wd: (s) => D.parse(s).getUTCDay(),
  monday: (s) => D.add(s, -((D.wd(s) + 6) % 7)),
  monthStart: (s) => s.slice(0, 8) + "01",
  prevMonthStart: (s) => { const dt = D.parse(D.monthStart(s)); dt.setUTCMonth(dt.getUTCMonth() - 1); return D.str(dt); },
  monthEnd: (s) => { const dt = D.parse(D.monthStart(s)); dt.setUTCMonth(dt.getUTCMonth() + 1); dt.setUTCDate(0); return D.str(dt); },
  diff: (a, b) => Math.round((D.parse(b) - D.parse(a)) / 86400000),
  week: (s) => { // ISO-weeknummer
    const dt = D.parse(s); const t = new Date(dt); t.setUTCDate(t.getUTCDate() + 3 - ((dt.getUTCDay() + 6) % 7));
    const w1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    return 1 + Math.round(((t - w1) / 86400000 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7);
  },
};
const dayLabel = (s) => { const [y, m, d] = s.split("-").map(Number); return `${DAYS[D.wd(s)]} ${d} ${MONTHS[m - 1]} ${y}`; };
const monthLabel = (s) => { const [y, m] = s.split("-").map(Number); return `${MONTHS_LONG[m - 1]} ${y}`; };
const monthShort = (s) => { const [y, m] = s.split("-").map(Number); return `${MONTHS[m - 1]} ${String(y).slice(2)}`; };

const CSS = `
  :host { display: block; min-width: 0; }
  ha-card { padding: 16px; }
  .muted { color: var(--secondary-text-color); }
  .title { font-size: 1.25rem; font-weight: 500; margin: 0 0 12px; color: var(--primary-text-color); }
  h3 { font-size: 1.05rem; font-weight: 500; margin: 20px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
  th { text-align: left; font-weight: 500; color: var(--secondary-text-color); padding: 8px; border-bottom: 1px solid var(--divider-color); white-space: nowrap; }
  td { padding: 8px; border-bottom: 1px solid var(--divider-color); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tfoot td { font-weight: 500; border-top: 2px solid var(--divider-color); }
  .link { color: var(--primary-color); cursor: pointer; background: none; border: none; padding: 0; font: inherit; text-align: left; }
  .link:hover { text-decoration: underline; }
  .error { color: var(--error-color, #db4437); padding: 8px 0; }
  .empty { color: var(--secondary-text-color); padding: 16px 0; text-align: center; }
  input, select, button.btn {
    font: inherit; color: var(--primary-text-color); background: var(--card-background-color, #fff);
    border: 1px solid var(--divider-color); border-radius: 8px; padding: 8px 10px; min-height: 40px; box-sizing: border-box;
  }
  button.btn { cursor: pointer; background: var(--secondary-background-color); }
  button.btn:hover { border-color: var(--primary-color); }
  button.btn.active { border-color: var(--primary-color); color: var(--primary-color); }
  button.btn.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  button.btn:disabled { opacity: 0.5; cursor: default; }
  button.btn.danger { background: var(--error-color, #db4437); color: #fff; border-color: var(--error-color, #db4437); }
  .scroll { overflow-x: auto; max-width: 100%; }
  .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; margin-bottom: 12px; }
  .kpi { background: var(--secondary-background-color); border-radius: 8px; padding: 10px 12px; min-width: 0; }
  .kpi .v { font-size: 1.3rem; font-weight: 500; font-variant-numeric: tabular-nums; }
  .kpi .s { font-size: 0.95rem; font-variant-numeric: tabular-nums; }
  .kpi .l { font-size: 0.8rem; color: var(--secondary-text-color); }
  .kpi.click { cursor: pointer; }
  .kpi.click:hover { outline: 1px solid var(--primary-color); }
  .live { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 21.5rem), 1fr)); gap: 12px; margin-bottom: 16px; }
  .meter { border: 1px solid var(--divider-color); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; min-width: 0; }
  .meter .head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
  .ph.tot { grid-template-columns: 14px minmax(0, 1fr) 4.8rem 4.4rem; }
  .meter .name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .meter .p { white-space: nowrap; line-height: 1.2; font-size: 1.6rem; font-weight: 500; font-variant-numeric: tabular-nums; }
  .ph { display: grid; grid-template-columns: 1.6rem minmax(24px, 1fr) 4.8rem 4.2rem 4.4rem; column-gap: 10px; align-items: center;
    font-size: 0.9rem; font-variant-numeric: tabular-nums; padding: 5px 0; border-top: 1px solid var(--divider-color); }
  .ph.hd { border-top: none; font-size: 0.75rem; color: var(--secondary-text-color); padding: 0 0 3px; }
  .ph .r { text-align: right; white-space: nowrap; }
  .ph .track { height: 8px; background: var(--secondary-background-color); border-radius: 4px; overflow: hidden; }
  .ph .fill { height: 100%; border-radius: 4px; }
  .seg { display: inline-flex; flex-wrap: wrap; gap: 0; border: 1px solid var(--divider-color); border-radius: 8px; overflow: hidden; }
  .seg button { font: inherit; border: none; background: none; color: var(--primary-text-color); padding: 7px 12px; cursor: pointer; min-height: 36px; }
  .seg button + button { border-left: 1px solid var(--divider-color); }
  .seg button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .selbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: -6px 0 14px; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 0.85rem; color: var(--secondary-text-color); margin: 4px 0 6px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .chart { position: relative; }
  .chart svg { width: 100%; display: block; overflow: visible; }
  .chart text { font-size: 11px; fill: var(--secondary-text-color); }
  .chart .grid { stroke: var(--divider-color); stroke-width: 1; }
  .chart .hit { fill: transparent; cursor: pointer; }
  .chart .hit:hover { fill: rgba(127, 127, 127, 0.08); }
  .tip { position: absolute; pointer-events: none; background: var(--card-background-color, #fff); color: var(--primary-text-color);
    border: 1px solid var(--divider-color); border-radius: 8px; padding: 8px 10px; font-size: 0.85rem; white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); display: none; z-index: 2; }
  .tip b { font-weight: 500; }
  .note { font-size: 0.8rem; color: var(--secondary-text-color); margin-top: 8px; line-height: 1.4; }
  .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 10px; }
  .panel { border: 1px solid var(--divider-color); border-radius: 8px; padding: 12px; margin: 12px 0; }
  .msg.ok { color: var(--success-color, #0b8043); }
  .daytitle { font-size: 1.1rem; font-weight: 500; margin: 0 8px; }

  @media (max-width: 640px) {
    .help td:first-child { white-space: normal; }
    .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .ph { grid-template-columns: 1.4rem minmax(16px, 1fr) 4.4rem 3.8rem 3.9rem; column-gap: 6px; font-size: 0.85rem; }
    .meter { padding: 12px 10px; }
    .kpi .v { font-size: 1.1rem; }
  }
`;

/* ------------------------------------------------------------------ grafieken (SVG) */

// Gestapelde staafgrafiek. series: [{name, color, values[]}]; labels: tekst per staaf; tip(i) geeft HTML.
function barChart(root, { labels, series, unit = "kWh", tip, onClick, height = 220, refLine, every }) {
  const W = Math.max(root.clientWidth || 700, 320), H = height, left = 48, right = 8, top = 24, bottom = 26;
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  let max = Math.max(...totals, refLine || 0, 0.001);
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const nice = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((f) => f * step).find((v) => v >= max) || max;
  const plotW = W - left - right, plotH = H - top - bottom;
  const y = (v) => top + plotH - (v / nice) * plotH;
  const band = plotW / Math.max(n, 1), bw = Math.max(1, Math.min(28, band * 0.7));
  const grid = [0, nice / 2, nice].map((v) => `<line class="grid" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"></line>
    <text x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${(Number.isInteger(v) ? N0 : N1).format(v)}</text>`).join("");
  const skip = Math.max(every || 1, Math.ceil(n / Math.max(1, Math.floor(plotW / 44))));
  let bars = "", xl = "", hits = "";
  labels.forEach((lab, i) => {
    const cx = left + band * i + band / 2;
    let acc = 0;
    series.forEach((s) => {
      const v = s.values[i] || 0;
      if (v <= 0) return;
      const y0 = y(acc), y1 = y(acc + v);
      acc += v;
      const top2 = acc === totals[i] ? Math.min(3, bw / 2) : 0;   // afgeronde bovenkant enkel op het hoogste deel
      bars += `<path d="M${cx - bw / 2},${y0} V${y1 + top2} Q${cx - bw / 2},${y1} ${cx - bw / 2 + top2},${y1} H${cx + bw / 2 - top2} Q${cx + bw / 2},${y1} ${cx + bw / 2},${y1 + top2} V${y0} Z" fill="${s.color}"></path>`;
    });
    if (i % skip === 0) xl += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(lab)}</text>`;
    hits += `<rect class="hit" data-i="${i}" x="${left + band * i}" y="${top}" width="${band}" height="${plotH}"></rect>`;
  });
  const ref = refLine ? `<line x1="${left}" x2="${W - right}" y1="${y(refLine)}" y2="${y(refLine)}" stroke="var(--error-color, #db4437)" stroke-dasharray="4 4" stroke-width="1.5"></line>
    <text x="${W - right}" y="${y(refLine) - 4}" text-anchor="end">minimum ${N1.format(refLine)} ${unit}</text>` : "";
  root.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="grafiek">${grid}${bars}${ref}${xl}
    <text x="${left - 6}" y="${top - 12}" text-anchor="end">${unit}</text>${hits}</svg><div class="tip"></div>`;
  wireTip(root, tip, onClick);
}

// Lijngrafiek over de tijd. series: [{name, color, points: [[ts, v]]}], x-bereik [x0, x1] (epoch s).
function lineChart(root, { series, x0, x1, unit, tip, height = 220, xlabel, zeroBase = true }) {
  const W = Math.max(root.clientWidth || 700, 320), H = height, left = 48, right = 8, top = 24, bottom = 26;
  const all = series.flatMap((s) => s.points.map((p) => p[1])).filter((v) => v != null);
  if (!all.length) { root.innerHTML = `<div class="empty">Geen gegevens voor deze dag.</div>`; return; }
  let lo = zeroBase ? 0 : Math.min(...all), hi = Math.max(...all);
  if (!zeroBase) { const pad = Math.max((hi - lo) * 0.1, 0.5); lo -= pad; hi += pad; }
  if (hi <= lo) hi = lo + 1;
  const plotW = W - left - right, plotH = H - top - bottom;
  const x = (t) => left + ((t - x0) / (x1 - x0)) * plotW;
  const y = (v) => top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const ticks = [lo, (lo + hi) / 2, hi];
  const grid = ticks.map((v) => `<line class="grid" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"></line>
    <text x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${(hi - lo < 10 ? N1 : N0).format(v)}</text>`).join("");
  let xl = "";
  for (let h = 0; h <= 24; h += 3) {
    const t = x0 + h * 3600;
    if (t > x1) break;
    xl += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${xlabel ? xlabel(t) : h}</text>`;
  }
  const lines = series.map((s) => {
    let d = "", prev = null;
    for (const [t, v] of s.points) {
      if (v == null) { prev = null; continue; }
      d += `${prev == null || t - prev > 3700 ? "M" : "L"}${x(t).toFixed(1)},${y(v).toFixed(1)} `;
      prev = t;
    }
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"></path>`;
  }).join("");
  // raakvlakken per tijdstip voor de tooltip
  const ts = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
  const hits = ts.map((t, i) => {
    const a = i ? (ts[i - 1] + t) / 2 : x0, b = i < ts.length - 1 ? (t + ts[i + 1]) / 2 : x1;
    return `<rect class="hit" data-i="${i}" x="${x(a)}" y="${top}" width="${Math.max(1, x(b) - x(a))}" height="${plotH}"></rect>`;
  }).join("");
  root.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="grafiek">${grid}${lines}${xl}
    <text x="${left - 6}" y="${top - 12}" text-anchor="end">${unit}</text>${hits}</svg><div class="tip"></div>`;
  wireTip(root, (i) => tip(ts[i]), null);
}

function wireTip(root, tip, onClick) {
  const tipEl = root.querySelector(".tip");
  root.querySelectorAll("rect.hit").forEach((r) => {
    const i = Number(r.dataset.i);
    r.addEventListener("mousemove", (ev) => {
      if (!tip) return;
      tipEl.innerHTML = tip(i);
      tipEl.style.display = "block";
      const box = root.getBoundingClientRect();
      let lx = ev.clientX - box.left + 14;
      if (lx + tipEl.offsetWidth > box.width) lx = ev.clientX - box.left - tipEl.offsetWidth - 14;
      tipEl.style.left = `${Math.max(0, lx)}px`;
      tipEl.style.top = `${Math.max(0, ev.clientY - box.top - tipEl.offsetHeight - 10)}px`;
    });
    r.addEventListener("mouseleave", () => { tipEl.style.display = "none"; });
    if (onClick) r.addEventListener("click", () => onClick(i));
  });
}

function csvDownload(name, rows) {
  const q = (v) => { let t = String(v ?? ""); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
  const blob = new Blob([String.fromCharCode(0xfeff) + rows.map((r) => r.map(q).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const csvNum = (v, d = 3) => (v == null ? "" : String(Math.round(v * 10 ** d) / 10 ** d).replace(".", ","));

/* ------------------------------------------------------------------ kaart */

// foutenlog van 60 dagen (enkel beheerders): waarschuwingen en fouten van deze integratie, ook na een herstart
function errorLogSection(root, hass, domain, dateTime) {
  const box = document.createElement("div");
  box.className = "errlog";
  box.innerHTML = `<h3 style="font-size:1.05rem;font-weight:500;margin:22px 0 8px">Foutenlog</h3>
    <p class="muted" style="margin:0 0 8px;font-size:0.9rem">Waarschuwingen en fouten van de laatste 60 dagen, ook na een herstart van Home Assistant. Dezelfde melding op dezelfde dag telt op.</p>
    <button class="btn" data-errlog>Foutenlog tonen</button><div class="errout"></div>`;
  root.appendChild(box);
  const out = box.querySelector(".errout"), btn = box.querySelector("[data-errlog]");
  const e2 = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  btn.addEventListener("click", async () => {
    if (out.dataset.open === "1") { out.innerHTML = ""; out.dataset.open = ""; btn.textContent = "Foutenlog tonen"; return; }
    btn.disabled = true;
    try {
      const r = await hass.callWS({ type: `${domain}/errors`, days: 60 });
      const t = r.totals || {};
      out.innerHTML = `<p style="margin:10px 0">${r.rows.length ? `<b>${(t.ERROR || 0) + (t.CRITICAL || 0)}</b> fouten en <b>${t.WARNING || 0}</b> waarschuwingen in 60 dagen.` : "Geen waarschuwingen of fouten in de laatste 60 dagen."}</p>
        ${r.rows.length ? `<div class="scroll"><table><thead><tr><th>Laatst</th><th>Niveau</th><th>Onderdeel</th><th>Melding</th><th class="num">Aantal</th></tr></thead><tbody>
        ${r.rows.map((x) => `<tr><td style="white-space:nowrap">${e2(dateTime(x.last))}</td><td>${x.level === "WARNING" ? "waarschuwing" : "fout"}</td><td>${e2(x.source)}</td>
          <td>${x.details ? `<details><summary>${e2(x.message)}</summary><pre style="white-space:pre-wrap;font-size:0.8rem;margin:6px 0 0">${e2(x.details)}</pre></details>` : e2(x.message)}</td>
          <td class="num">${x.count}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
      out.dataset.open = "1"; btn.textContent = "Foutenlog verbergen";
    } catch (e) {
      out.innerHTML = `<div class="error">Foutenlog laden mislukt: ${e2((e && e.message) || e)}</div>`;
    } finally { btn.disabled = false; }
  });
}

const TABS = [["overzicht", "Overzicht"], ["dag", "Dag"], ["periode", "Periode"], ["pieken", "Pieken"], ["evenementen", "Evenementen"], ["tarieven", "Tarieven"], ["handleiding", "Handleiding"]];

/* ------------------------------------------------------------------ handleiding (gedeelde opbouw)
   Opbouw: zoeken, "Wat wil je doen?" als tegels met korte stappen, uitleg per scherm inklapbaar, begrippen. */
const HELP_CSS = `
  .hp { max-width: 980px; line-height: 1.5; }
  .hp-search { width: 100%; max-width: 420px; margin: 0 0 14px; }
  .hp h3 { font-size: 1.05rem; font-weight: 500; margin: 18px 0 10px; }
  .hp-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
  .hp-tile { display: flex; gap: 10px; align-items: flex-start; text-align: left; font: inherit; color: var(--primary-text-color);
    background: var(--secondary-background-color); border: 1px solid transparent; border-radius: 10px; padding: 12px; cursor: pointer; }
  .hp-tile:hover, .hp-tile.on { border-color: var(--primary-color); }
  .hp-tile ha-icon { color: var(--primary-color); flex: none; --mdc-icon-size: 22px; }
  .hp-tile b { display: block; font-weight: 500; }
  .hp-tile span { font-size: 0.85rem; color: var(--secondary-text-color); }
  .hp-steps { border: 1px solid var(--primary-color); border-radius: 10px; padding: 12px 16px; margin: 12px 0 4px; }
  .hp-steps h4 { margin: 0 0 6px; font-size: 1rem; font-weight: 500; display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .hp-steps ol { margin: 4px 0 6px; padding-left: 22px; }
  .hp-steps li { margin: 3px 0; }
  .hp-steps .hp-tip { font-size: 0.85rem; color: var(--secondary-text-color); margin: 4px 0 0; }
  .hp details { border-bottom: 1px solid var(--divider-color); }
  .hp summary { cursor: pointer; padding: 10px 2px; list-style: none; display: flex; gap: 10px; align-items: baseline; }
  .hp summary::-webkit-details-marker { display: none; }
  .hp summary::before { content: "+"; width: 14px; color: var(--primary-color); font-weight: 600; flex: none; }
  .hp details[open] summary::before { content: "\\2212"; }
  .hp summary b { font-weight: 500; }
  .hp summary span { font-size: 0.85rem; color: var(--secondary-text-color); }
  .hp .body { padding: 0 2px 12px 24px; }
  .hp .body p { margin: 4px 0 8px; }
  .hp .body td:first-child, .hp-terms td:first-child { white-space: nowrap; font-weight: 500; width: 1%; }
  .hp .hidden { display: none; }
  .hp .none { color: var(--secondary-text-color); padding: 8px 0; }
  @media (max-width: 640px) { .hp .body td:first-child, .hp-terms td:first-child { white-space: normal; } .hp .body { padding-left: 6px; } }
`;
const hpTable = (rows) => `<div class="scroll"><table><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
function helpHtml(doc) {
  return `<div class="hp">
    <input class="hp-search" type="search" placeholder="Zoek in de handleiding, ${doc.hint || ""}" aria-label="Zoek in de handleiding">
    <h3>Wat wil je doen?</h3>
    <div class="hp-tiles">${doc.tasks.map((t, i) => `<button class="hp-tile" data-task="${i}"><ha-icon icon="${t.icon}"></ha-icon><div><b>${t.title}</b><span>${t.sub}</span></div></button>`).join("")}</div>
    <div class="hp-steps hidden"></div>
    <div class="none hidden">Niets gevonden.</div>
    <h3>Uitleg per scherm</h3>
    ${doc.topics.map((t) => `<details data-topic><summary><b>${t.title}</b><span>${t.sub}</span></summary><div class="body">${t.html}</div></details>`).join("")}
    <h3>Begrippen</h3>
    <div class="hp-terms">${hpTable(doc.terms)}</div>
    ${doc.foot ? `<p class="muted" style="font-size:0.8rem;margin-top:12px">${doc.foot}</p>` : ""}
  </div>`;
}
function wireHelp(root, doc, openTab) {
  const steps = root.querySelector(".hp-steps");
  const show = (i) => {
    const t = doc.tasks[i];
    root.querySelectorAll(".hp-tile").forEach((b) => b.classList.toggle("on", Number(b.dataset.task) === i));
    steps.innerHTML = `<h4><span>${t.title}</span>${t.tab ? `<button class="btn" data-open-tab="${t.tab}">Naar ${t.tabName || t.tab} &rsaquo;</button>` : ""}</h4>
      <ol>${t.steps.map((s) => `<li>${s}</li>`).join("")}</ol>${t.tip ? `<p class="hp-tip">${t.tip}</p>` : ""}`;
    steps.classList.remove("hidden");
    const ob = steps.querySelector("[data-open-tab]");
    if (ob) ob.addEventListener("click", () => openTab(ob.dataset.openTab));
    steps.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  root.querySelectorAll(".hp-tile").forEach((b) => b.addEventListener("click", () => show(Number(b.dataset.task))));
  const text = (html) => html.replace(/<[^>]+>/g, " ").toLowerCase();
  const input = root.querySelector(".hp-search");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    let hits = 0;
    root.querySelectorAll(".hp-tile").forEach((b) => {
      const t = doc.tasks[Number(b.dataset.task)];
      const ok = !q || text(`${t.title} ${t.sub} ${t.steps.join(" ")} ${t.tip || ""}`).includes(q);
      b.classList.toggle("hidden", !ok); hits += ok;
    });
    root.querySelectorAll("details[data-topic]").forEach((d, i) => {
      const t = doc.topics[i];
      const ok = !q || text(`${t.title} ${t.sub} ${t.html}`).includes(q);
      d.classList.toggle("hidden", !ok); d.open = !!q && ok; hits += ok;
    });
    if (q) steps.classList.add("hidden");
    root.querySelector(".none").classList.toggle("hidden", hits > 0);
  });
}

const HELP_DOC = {
  hint: "bv. PDF of tarief",
  tasks: [
    { icon: "mdi:flash", title: "Zien wat er nu verbruikt wordt", sub: "Live vermogen per meter en fase", tab: "overzicht", tabName: "Overzicht",
      steps: ["Open <b>Overzicht</b>.", "Bovenaan staat per meter een kaart met het vermogen nu (kW).", "Per fase L1, L2, L3: vermogen, stroom (A) en spanning (V). De balk toont hoe zwaar de fase belast is.", "De kaart <b>Totaal nu</b> telt Voorbouw en Achterbouw op, met het aandeel van elke meter."],
      tip: "Is een fase veel zwaarder dan de andere, dan is de belasting ongelijk verdeeld." },
    { icon: "mdi:calendar-today", title: "Een dag in detail bekijken", sub: "Per uur of kwartier, met kost", tab: "dag", tabName: "Dag",
      steps: ["Open <b>Dag</b>.", "Kies de dag met de pijltjes, de kalender of Vandaag en Gisteren.", "Kies <b>Per uur</b> (kWh) of <b>Per kwartier</b> (kW).", "Onderaan: tabel per uur met verbruik per meter en kost; bij <b>Per fase</b> vermogen, stroom en spanning.", "Nodig in Excel? Klik op <b>CSV per uur</b> of <b>CSV per kwartier</b>."],
      tip: "Klik op een balk of dag in eender welke grafiek: je komt meteen hier." },
    { icon: "mdi:calculator-variant", title: "Voorbouw of Achterbouw doorrekenen", sub: "Verbruik en kost over een maand of jaar", tab: "periode", tabName: "Periode",
      steps: ["Kies bovenaan de meter: <b>Speldenstraat Voorbouw</b> of <b>Speldenstraat Achterbouw</b>.", "Open <b>Periode</b>.", "Kies de periode, bv. <b>Vorige maand</b>, of <b>Eigen periode</b> met Van en Tot.", "Kies <b>Per dag</b>, <b>Per week</b> of <b>Per maand</b>.", "Lees het totaal af in de tegels Verbruik en Kost, of klik op <b>CSV</b> voor Excel."],
      tip: "Elke dag wordt gerekend tegen het tarief dat die dag gold. Het capaciteitstarief zit er niet in." },
    { icon: "mdi:file-document-outline", title: "Een evenement afrekenen", sub: "Sessie, optreden of expo, met PDF", tab: "evenementen", tabName: "Evenementen",
      steps: ["Open <b>Evenementen</b> en klik op <b>Nieuw evenement</b>.", "Vul de naam in, en eventueel organisator en contact.", "Kies <b>Begin</b> en <b>Einde</b> (datum en uur) en vink de meters aan, meestal Voorbouw.", "Vul een eigen prijs per kWh in, of laat leeg voor het tarief van die dag.", "Kijk de berekening onder het formulier na: verbruik, meterstanden, bedrag.", "Klik op <b>Opslaan</b> en daarna op <b>PDF</b>."],
      tip: "Loopt het evenement nog, dan staat er \"loopt nog\" op. Maak de PDF na afloop opnieuw voor de eindcijfers." },
    { icon: "mdi:delete-outline", title: "Een evenement verwijderen", sub: "Uit de lijst halen", tab: "evenementen", tabName: "Evenementen",
      steps: ["Open <b>Evenementen</b>.", "Klik op <b>Verwijderen</b> naast PDF bij het juiste evenement.", "De knop wordt rood: klik binnen 6 seconden nog eens om te bevestigen."],
      tip: "Het referentienummer (EV-jaar-nummer) van het laatste evenement kan daarna opnieuw gebruikt worden." },
    { icon: "mdi:currency-eur", title: "Een nieuw tarief ingeven", sub: "Prijs per kWh vanaf een datum", tab: "tarieven", tabName: "Tarieven",
      steps: ["Open <b>Tarieven</b>.", "Kies de datum vanaf wanneer het tarief geldt.", "Vul de all-in prijs per kWh in zoals op de factuur (energie, nettarieven en heffingen per kWh, inclusief btw).", "Klik op <b>Opslaan</b>."],
      tip: "Vroegere dagen blijven tegen hun eigen tarief gerekend." },
    { icon: "mdi:chart-bell-curve", title: "De kwartierpiek nakijken", sub: "Wat het capaciteitstarief bepaalt", tab: "pieken", tabName: "Pieken",
      steps: ["Open <b>Pieken</b>.", "Bovenaan: de piek van deze maand en de facturatiepiek (gemiddelde van 12 maanden).", "Klik op een piek of maand: je ziet die dag per kwartier en wat er toen draaide."],
      tip: "Het is een benadering: de meters melden via de cloud om de 1 tot 6 minuten. De offici&euml;le piek staat in Mijn Fluvius." },
  ],
  topics: [
    { title: "Meterkeuze", sub: "Alle meters, Voorbouw of Achterbouw", html: `<p>Boven de tabbladen kies je welke meter je bekijkt. De keuze geldt voor Overzicht, Dag, Periode en Pieken, en staat ook in de naam van elk CSV-bestand. Het gebouw heeft een aansluiting met twee meters; Alle meters is de som.</p>` },
    { title: "Overzicht", sub: "Live, vandaag tot dit jaar, laatste 30 dagen", html: hpTable([["Live kaarten", "Vermogen per meter; per fase vermogen, stroom en spanning"], ["Tegels", "Vandaag, Gisteren, Deze en Vorige week, Deze en Vorige maand, Dit jaar: kWh en kost. Klik op Vandaag of Gisteren voor de dag"], ["Kwartierpiek", "Hoogste kwartier deze maand en de facturatiepiek; klik voor Pieken"], ["Laatste 30 dagen", "Verbruik per dag per meter; klik op een balk voor die dag"]]) },
    { title: "Dag", sub: "Per uur, kwartier en fase", html: hpTable([["Tegels", "Verbruik, kost, per meter, kwartierpiek, gemiddeld vermogen"], ["Grafiek", "Per uur (kWh) of per kwartier (kW); per kwartier vanaf 16 sep 2026"], ["Per fase", "Vermogen, stroom of spanning per fase; laatste 10 dagen per 5 minuten, daarvoor per uur"], ["Per uur", "Tabel met verbruik per meter en kost"], ["CSV", "Per uur of per kwartier"]]) },
    { title: "Periode", sub: "Per dag, week of maand, met CSV", html: hpTable([["Periode", "Deze maand, Vorige maand, Laatste 30 dagen, Dit jaar, Vorig jaar, Eigen periode"], ["Groeperen", "Per dag, week of maand"], ["Dag opzoeken", "Kies een datum en je gaat naar Dag"], ["Tabel", "Verbruik per meter, totaal, tarief (\"meerdere\" = tarief veranderde), kost, kwartierpiek"]]) },
    { title: "Pieken", sub: "Maandpiek en facturatiepiek", html: `<p>De maandpiek is het hoogste gemiddelde vermogen over een kwartier in die maand. Fluvius rekent minstens 2,5 kW per maand en neemt het gemiddelde van de voorbije 12 maanden. Met Alle meters zie je de piek van de aansluiting. Een kwartier direct na een onderbreking van de gegevens telt niet mee: dat bevat het verbruik van de hele onderbreking.</p>` },
    { title: "Evenementen", sub: "Lijst, berekening en PDF", html: hpTable([["Lijst", "Referentie, naam, organisator, periode, meters, verbruik, bedrag; zoeken; PDF en Verwijderen per evenement"], ["Verbruik", "Som van de kwartieren tussen begin en einde, afgerond op het kwartier"], ["Meterstanden", "Stand bij begin en einde (som van de drie fasen)"], ["Ontbrekend kwartier", "Geschat uit het uurverbruik en zo vermeld"], ["PDF", "Op naam van TrefpuntFestival vzw, met meterstanden, bedrag, opmerking en twee vakken voor handtekening"]]) },
    { title: "Tarieven", sub: "Prijs per kWh met historiek", html: `<p>Een tarief geldt vanaf 00u00 op die datum tot het volgende. Een verkeerd tarief verwijder je met Verwijderen; het laatste kan niet weg. Enkel beheerders kunnen tarieven en evenementen aanpassen.</p>` },
    { title: "Hoe er gemeten wordt", sub: "Bronnen en beperkingen", html: hpTable([["Meters", "Twee Shelly-energiemeters met drie fasen"], ["Uur, dag, maand", "Statistieken van Home Assistant, vanaf 15 sep 2026"], ["Kwartieren", "Elke 5 minuten overgenomen met de meterstand, vanaf 16 sep 2026"], ["Nauwkeurigheid", "kWh klopt; een kwartierpiek kan wat afwijken van de meter van Fluvius"]]) },
  ],
  terms: [
    ["Geschat (*)", "De meter was even onbereikbaar. Het verbruik van die periode (de meterstand liep gewoon door) is gelijk verdeeld over de ontbrekende uren; het totaal klopt, de verdeling per uur is een schatting. Kwartierpieken in die periode zijn niet gekend."],
    ["kWh", "Hoeveelheid energie: wat je betaalt per kWh"], ["kW", "Vermogen op een moment: hoe hard er nu verbruikt wordt"],
    ["Kwartierpiek", "Gemiddeld vermogen over het zwaarste kwartier"], ["Facturatiepiek", "Gemiddelde van de maandpieken van 12 maanden, minstens 2,5 kW per maand"],
    ["Fase L1, L2, L3", "De drie fasen van de aansluiting"], ["All-in tarief", "Prijs per kWh inclusief nettarieven, heffingen en btw"],
    ["Meterstand", "Totaal van de meter op een moment (som van de drie fasen)"],
  ],
  foot: "Bron capaciteitstarief: Fluvius (fluvius.be), Hoe wordt het capaciteitstarief aangerekend en Het capaciteitstarief op mijn factuur.",
};
const PRESETS = [["month", "Deze maand"], ["prevmonth", "Vorige maand"], ["30", "Laatste 30 dagen"], ["year", "Dit jaar"],
  ["prevyear", "Vorig jaar"], ["custom", "Eigen periode"]];

class BtechnicsEnergieCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._tab = "overzicht";
    this._res = "hour";
    this._phMeter = null;
    this._phKind = "power";
    this._period = { preset: "month", group: "day", from: null, to: null };
  }
  setConfig(config) {
    this._config = config || {};
    if (this._config.tab) this._tab = this._config.tab;
  }
  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._fmt = makeFmt(hass.config && hass.config.time_zone);
      this._init();
    } else if (this._tab === "overzicht" && this._ov && Date.now() - (this._liveAt || 0) > 2000) {
      this._liveAt = Date.now();
      this._renderLive();
    }
  }
  get hass() { return this._hass; }
  getCardSize() { return 12; }
  getGridOptions() { return { columns: "full", min_columns: 6 }; }
  static getStubConfig() { return {}; }

  connectedCallback() {
    if (this._hass && !this._timer) {
      this._timer = setInterval(() => this._refresh(), 300000);   // elke 5 minuten
    }
  }
  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
  }

  get _colors() {
    const dark = !!(this._hass && this._hass.themes && this._hass.themes.darkMode);
    return SERIES[dark ? "dark" : "light"];
  }
  get _isAdmin() { return !!(this._hass && this._hass.user && this._hass.user.is_admin); }
  _ws(msg) { return this._hass.callWS(msg); }
  _today() { return this._fmt.isoOf(Date.now() / 1000); }

  _init() {
    this.shadowRoot.innerHTML = `<style>${CSS}${HELP_CSS}</style><ha-card>
      <div class="title">${esc(this._config.title || "Energieverbruik")}</div>
      <div class="tabs" id="tabs"></div>
      <div class="selbar" id="selbar"></div>
      <div id="body"><div class="muted">Laden...</div></div></ha-card>`;
    this._renderTabs();
    this._day = this._today();
    this._show();
    if (!this._timer) this._timer = setInterval(() => this._refresh(), 300000);
  }
  _renderTabs() {
    const t = this.shadowRoot.getElementById("tabs");
    t.innerHTML = TABS.map(([k, l]) => `<button class="btn ${this._tab === k ? "active" : ""}" data-tab="${k}" aria-pressed="${this._tab === k}">${l}</button>`).join("");
    t.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { this._tab = b.dataset.tab; this._renderTabs(); this._show(); }));
    this._renderSel();
  }
  _refresh() {
    if (!this.isConnected || this._busy) return;
    if (this._tab === "overzicht" || this._tab === "pieken") this._show();
    else if (this._tab === "dag" && this._day === this._today()) this._show();
  }
  _show() {
    const seq = (this._seq = (this._seq || 0) + 1);
    const body = this.shadowRoot.getElementById("body");
    const fail = (e) => { if (seq === this._seq) body.innerHTML = `<div class="error">Kon de gegevens niet laden: ${esc(errText(e))}</div>`; };
    const run = { overzicht: () => this._overview(seq), dag: () => this._dayView(seq), periode: () => this._periodView(seq),
      pieken: () => this._peaksView(seq), tarieven: () => this._tariffView(seq), evenementen: () => this._eventsView(seq),
      handleiding: () => this._helpView() }[this._tab];
    return run().catch(fail);
  }
  _goDay(d) {
    this._day = d;
    this._tab = "dag";
    this._renderTabs();
    this._show();
  }

  _short(id) {
    // kortste herkenbare naam: gemeenschappelijke eerste woorden weglaten ("Speldenstraat Voorbouw" -> "Voorbouw")
    const all = this._allMeters || [];
    const m = all.find((x) => x.id === id);
    if (!m || all.length < 2) return m ? m.name : id;
    const words = all.map((x) => x.name.split(/\s+/));
    let k = 0;
    while (words.every((w) => w.length > k + 1 && w[k] === words[0][k])) k++;
    return m.name.split(/\s+/).slice(k).join(" ");
  }
  _meterIndex(id) {
    const i = (this._allMeters || []).findIndex((m) => m.id === id);
    return i < 0 ? 0 : i;
  }
  _fileTag() {
    return this._sel && this._sel.length ? "-" + this._selName().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "";
  }
  _selArg() { return this._sel && this._sel.length ? { meters: this._sel } : {}; }
  _selName() {
    const all = this._allMeters || [];
    if (!this._sel || !this._sel.length || this._sel.length === all.length) return "alle meters";
    return all.filter((m) => this._sel.includes(m.id)).map((m) => m.name).join(" en ");
  }
  _setAll(list) {
    if (!list || !list.length) return;
    const known = (this._allMeters || []).map((m) => m.id).join("|");
    this._allMeters = list;
    if (known !== list.map((m) => m.id).join("|")) this._renderSel();
  }
  _renderSel() {
    const el = this.shadowRoot.getElementById("selbar");
    if (!el) return;
    const all = this._allMeters || [];
    const show = all.length > 1 && ["overzicht", "dag", "periode", "pieken"].includes(this._tab);
    if (!show) { el.innerHTML = ""; return; }
    const cur = this._sel && this._sel.length === 1 ? this._sel[0] : "";
    el.innerHTML = `<span class="muted">Meters</span><div class="seg" role="group" aria-label="Meters">
      <button class="${cur ? "" : "on"}" data-sel="" aria-pressed="${!cur}">Alle meters</button>
      ${all.map((m) => `<button class="${cur === m.id ? "on" : ""}" data-sel="${esc(m.id)}" aria-pressed="${cur === m.id}">${esc(m.name)}</button>`).join("")}</div>`;
    el.querySelectorAll("[data-sel]").forEach((b) => b.addEventListener("click", () => {
      this._sel = b.dataset.sel ? [b.dataset.sel] : null;
      this._renderSel();
      this._show();
    }));
  }
  _legend(meters) {
    const c = this._colors;
    return `<div class="legend">${meters.map((m) => `<span><i class="sw" style="background:${c[this._meterIndex(m.id) % c.length]}"></i>${esc(m.name)}</span>`).join("")}</div>`;
  }
  _meterSplit(meters, per, fmt = (v) => kwh(v, 2)) {
    return meters.map((m) => `${esc(m.name)}: <b>${fmt(per[m.id])}</b>`).join("<br>");
  }

  /* ---------------- overzicht ---------------- */
  async _overview(seq) {
    const today = this._today();
    const start = [D.add(today, -40), `${Number(today.slice(0, 4)) - 1}-12-25`, D.prevMonthStart(today)].sort()[0];
    const [res, pk] = await Promise.all([this._ws({ type: `${DOMAIN}/days`, start, end: today, ...this._selArg() }),
      this._ws({ type: `${DOMAIN}/peaks`, ...this._selArg() })]);
    if (seq !== this._seq) return;
    this._ov = res;
    this._setAll(res.all_meters);
    this._meters = res.meters;
    const byDate = Object.fromEntries(res.days.map((d) => [d.date, d]));
    const sum = (a, b) => {
      const out = { kwh: 0, cost: 0, n: 0, per: {} };
      for (let d = a; d <= b; d = D.add(d, 1)) {
        const x = byDate[d];
        if (!x) continue;
        out.kwh += x.total; out.cost += x.cost || 0; out.n++;
        for (const [m, v] of Object.entries(x.meters)) out.per[m] = (out.per[m] || 0) + v;
      }
      return out;
    };
    const mon = D.monday(today), ms = D.monthStart(today), pms = D.prevMonthStart(today);
    const yday = D.add(today, -1);
    const k = [
      ["Vandaag", sum(today, today), today, `sinds 00u00`],
      ["Gisteren", sum(yday, yday), yday, dayLabel(yday)],
      ["Deze week", sum(mon, today), null, `vanaf ${dayLabel(mon)}`],
      ["Vorige week", sum(D.add(mon, -7), D.add(mon, -1)), null, `week ${D.week(D.add(mon, -7))}`],
      ["Deze maand", sum(ms, today), null, monthLabel(ms)],
      ["Vorige maand", sum(pms, D.add(ms, -1)), null, monthLabel(pms)],
      ["Dit jaar", sum(today.slice(0, 4) + "-01-01", today), null, today.slice(0, 4)],
    ];
    const curMonth = today.slice(0, 7);
    const mp = (pk.months || []).find((m) => m.month === curMonth);
    const body = this.shadowRoot.getElementById("body");
    body.innerHTML = `
      <div class="live" id="live"></div>
      <div class="kpis">${k.map(([l, s, d, sub]) => `<div class="kpi ${d ? "click" : ""}" ${d ? `data-day="${d}"` : ""} title="${d ? "Dag in detail" : ""}">
        <div class="l">${l}</div><div class="v">${s.n ? kwh(s.kwh) : "-"}</div><div class="s">${s.n ? eur(s.cost) : "geen gegevens"}</div><div class="l">${esc(sub)}</div></div>`).join("")}
        <div class="kpi click" data-tab="pieken"><div class="l">Kwartierpiek deze maand</div><div class="v">${mp ? kw(mp.kw) : "-"}</div>
          <div class="s">${mp ? esc(this._fmt.dateTime(mp.ts)) : "nog geen gegevens"}</div><div class="l">facturatiepiek ${pk.billing_peak != null ? kw(pk.billing_peak) : "-"}</div></div>
      </div>
      <h3>Laatste 30 dagen</h3>${this._legend(res.meters)}<div class="chart" id="c30"></div>
      <div class="note">Klik op een dag voor het verbruik per uur en per fase. Kost volgens het tarief van die dag (zie Tarieven).</div>`;
    body.querySelectorAll("[data-day]").forEach((e) => e.addEventListener("click", () => this._goDay(e.dataset.day)));
    body.querySelectorAll(".kpi[data-tab]").forEach((e) => e.addEventListener("click", () => { this._tab = e.dataset.tab; this._renderTabs(); this._show(); }));
    const days = []; for (let d = D.add(today, -29); d <= today; d = D.add(d, 1)) days.push(d);
    const c = this._colors;
    barChart(body.querySelector("#c30"), {
      labels: days.map((d) => `${Number(d.slice(8))}/${Number(d.slice(5, 7))}`),
      series: res.meters.map((m, i) => ({ name: m.name, color: c[this._meterIndex(m.id) % c.length], values: days.map((d) => (byDate[d] ? byDate[d].meters[m.id] || 0 : 0)) })),
      tip: (i) => { const x = byDate[days[i]]; return `<b>${dayLabel(days[i])}</b><br>${x ? `${kwh(x.total, 2)}, ${eur(x.cost)}<br>${this._meterSplit(res.meters, x.meters)}` : "geen gegevens"}`; },
      onClick: (i) => this._goDay(days[i]),
    });
    this._renderLive();
  }
  _renderLive() {
    const el = this.shadowRoot.getElementById("live");
    if (!el || !this._meters) return;
    const st = this._hass.states, c = this._colors;
    const num = (id) => { const s = id && st[id]; const v = s ? Number(s.state) : NaN; return Number.isFinite(v) ? v : null; };
    let total = 0, any = false;
    const cards = this._meters.map((m, i) => {
      const ph = ["1", "2", "3"].map((p) => ({ p, w: num(m.power[p]), a: num(m.current[p]), v: num(m.voltage[p]) }));
      const w = ph.reduce((s, x) => s + (x.w || 0), 0);
      if (ph.some((x) => x.w != null)) { total += w; any = true; }
      const maxA = Math.max(16, ...ph.map((x) => x.a || 0));
      const col = c[this._meterIndex(m.id) % c.length];
      return `<div class="meter"><div class="head"><span class="name" title="${esc(m.name)}"><i class="sw" style="background:${col}"></i> ${esc(m.name)}</span>
        <span class="p">${ph.some((x) => x.w != null) ? kw(w / 1000) : "-"}</span></div>
        <div class="ph hd"><span>Fase</span><span>Stroom</span><span class="r">Vermogen</span><span class="r">Stroom</span><span class="r">Spanning</span></div>
        ${ph.map((x) => `<div class="ph"><span class="muted">L${x.p}</span><div class="track" title="${x.a != null ? N1.format(x.a) + " A" : ""}"><div class="fill" style="width:${Math.min(100, ((x.a || 0) / maxA) * 100)}%;background:${col}"></div></div>
          <span class="r">${x.w != null ? `${N2.format(x.w / 1000)} kW` : "-"}</span><span class="r">${x.a != null ? `${N1.format(x.a)} A` : "-"}</span><span class="r">${x.v != null ? `${N0.format(x.v)} V` : "-"}</span></div>`).join("")}
      </div>`;
    }).join("");
    const shown = this._meters.length;
    el.innerHTML = cards + (shown > 1 ? `<div class="meter"><div class="head"><span class="name">Totaal nu</span><span class="p">${any ? kw(total / 1000) : "-"}</span></div>
      <div class="ph hd tot"><span></span><span>Meter</span><span class="r">Vermogen</span><span class="r">Aandeel</span></div>
      ${this._meters.map((m) => { const w = ["1", "2", "3"].reduce((s2, p) => s2 + (num(m.power[p]) || 0), 0);
        return `<div class="ph tot"><span><i class="sw" style="background:${c[this._meterIndex(m.id) % c.length]}"></i></span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(m.name)}">${esc(this._short(m.id))}</span>
          <span class="r">${N2.format(w / 1000)} kW</span><span class="r">${total > 0 ? N0.format((w / total) * 100) + " %" : "-"}</span></div>`; }).join("")}
      <div class="note">Een kwartier op dit vermogen: ${any ? kwh(total / 4000, 2) : "-"}.</div></div>` : "");
  }

  /* ---------------- dag ---------------- */
  async _dayView(seq) {
    const d = this._day;
    const body = this.shadowRoot.getElementById("body");
    if (!body.querySelector("#daynav")) body.innerHTML = `<div class="muted">Laden...</div>`;
    const res = await this._ws({ type: `${DOMAIN}/day`, date: d });
    if (seq !== this._seq) return;
    if (!this._allMeters) this._setAll(res.meters);
    if (this._sel && this._sel.length) {
      const keep = (per) => Object.fromEntries(Object.entries(per).filter(([m]) => this._sel.includes(m)));
      res.meters = res.meters.filter((m) => this._sel.includes(m.id));
      res.hours = res.hours.map((h) => ({ ...h, meters: keep(h.meters) }));
      res.quarters = res.quarters.map((q) => ({ ...q, meters: keep(q.meters) }));
    }
    this._meters = res.meters;
    const f = this._fmt, c = this._colors, meters = res.meters, today = this._today();
    const hours = res.hours, quarters = res.quarters;
    const tot = {}; let total = 0;
    hours.forEach((h) => Object.entries(h.meters).forEach(([m, v]) => { tot[m] = (tot[m] || 0) + v; total += v; }));
    let peak = null;
    // kwartier na een gat in de gegevens (bevat het verbruik van de hele onderbreking) telt niet mee
    quarters.forEach((q) => { if (q.gap) return; const k = Object.values(q.meters).reduce((a, b) => a + b, 0) * 4; if (!peak || k > peak.kw) peak = { kw: k, ts: q.ts }; });
    const cost = res.price != null ? total * res.price : null;
    const hrs = Math.max(1, Math.min(24, (Math.min(Date.now() / 1000, res.end) - res.start) / 3600));
    if (!this._phMeter || !meters.find((m) => m.id === this._phMeter)) this._phMeter = meters[0] && meters[0].id;
    body.innerHTML = `
      <div class="bar" id="daynav">
        <button class="btn" id="prev" title="Vorige dag" aria-label="Vorige dag">&lsaquo;</button>
        <input type="date" id="date" value="${d}" max="${today}" aria-label="Datum">
        <button class="btn" id="next" title="Volgende dag" aria-label="Volgende dag" ${d >= today ? "disabled" : ""}>&rsaquo;</button>
        <button class="btn" id="tod">Vandaag</button><button class="btn" id="yes">Gisteren</button>
        <span class="daytitle">${dayLabel(d)}</span>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="l">Verbruik</div><div class="v">${kwh(total, 2)}</div><div class="l">${d === today ? "tot nu" : "hele dag"}</div></div>
        <div class="kpi"><div class="l">Kost</div><div class="v">${eur(cost)}</div><div class="l">tarief ${res.price != null ? `${EUR4.format(res.price)}/kWh` : "niet ingesteld"}</div></div>
        ${meters.map((m, i) => `<div class="kpi"><div class="l"><i class="sw" style="background:${c[this._meterIndex(m.id) % c.length]}"></i> ${esc(m.name)}</div><div class="v">${kwh(tot[m.id], 2)}</div>
          <div class="l">${res.price != null && tot[m.id] != null ? eur(tot[m.id] * res.price) : ""}</div></div>`).join("")}
        <div class="kpi"><div class="l">Kwartierpiek</div><div class="v">${peak ? kw(peak.kw) : "-"}</div><div class="l">${peak ? `${f.time(peak.ts)} tot ${f.time(peak.ts + 900)}` : "geen kwartiergegevens"}</div></div>
        <div class="kpi"><div class="l">Gemiddeld vermogen</div><div class="v">${kw(total / hrs)}</div><div class="l">over ${N1.format(hrs)} uur</div></div>
      </div>
      <div class="bar"><button class="btn ${this._res === "hour" ? "active" : ""}" data-res="hour">Per uur</button>
        <button class="btn ${this._res === "quarter" ? "active" : ""}" data-res="quarter" ${quarters.length ? "" : "disabled title=\"Geen kwartiergegevens voor deze dag\""}>Per kwartier</button>
        <span style="flex:1"></span><button class="btn" id="csvh">CSV per uur</button><button class="btn" id="csvq" ${quarters.length ? "" : "disabled"}>CSV per kwartier</button></div>
      ${this._legend(meters)}<div class="chart" id="cday"></div>
      <h3>Per fase</h3>
      <div class="bar">${meters.map((m) => `<button class="btn ${this._phMeter === m.id ? "active" : ""}" data-phm="${esc(m.id)}">${esc(m.name)}</button>`).join("")}
        <span style="width:12px"></span>${[["power", "Vermogen"], ["current", "Stroom"], ["voltage", "Spanning"]].map(([k, l]) => `<button class="btn ${this._phKind === k ? "active" : ""}" data-phk="${k}">${l}</button>`).join("")}</div>
      <div class="legend"><span><i class="sw" style="background:${c[0]}"></i>L1</span><span><i class="sw" style="background:${c[1]}"></i>L2</span><span><i class="sw" style="background:${c[2]}"></i>L3</span></div>
      <div class="chart" id="cph"></div><div class="scroll" id="phtab"></div>
      <div class="note">${res.phase_period === "5minute" ? "Gemiddelde per 5 minuten." : "Gemiddelde per uur (Home Assistant bewaart 5-minuutwaarden maar 10 dagen)."}</div>
      <h3>Per uur</h3><div class="scroll" id="htab"></div>`;
    const nav = (x) => { if (x && x <= today) this._goDay(x); };
    body.querySelector("#prev").addEventListener("click", () => nav(D.add(d, -1)));
    body.querySelector("#next").addEventListener("click", () => nav(D.add(d, 1)));
    body.querySelector("#tod").addEventListener("click", () => nav(today));
    body.querySelector("#yes").addEventListener("click", () => nav(D.add(today, -1)));
    body.querySelector("#date").addEventListener("change", (e) => nav(e.target.value));
    body.querySelectorAll("[data-res]").forEach((b) => b.addEventListener("click", () => { this._res = b.dataset.res; this._drawDay(res); body.querySelectorAll("[data-res]").forEach((x) => x.classList.toggle("active", x === b)); }));
    body.querySelectorAll("[data-phm]").forEach((b) => b.addEventListener("click", () => { this._phMeter = b.dataset.phm; body.querySelectorAll("[data-phm]").forEach((x) => x.classList.toggle("active", x === b)); this._drawPhases(res); }));
    body.querySelectorAll("[data-phk]").forEach((b) => b.addEventListener("click", () => { this._phKind = b.dataset.phk; body.querySelectorAll("[data-phk]").forEach((x) => x.classList.toggle("active", x === b)); this._drawPhases(res); }));
    body.querySelector("#csvh").addEventListener("click", () => csvDownload(`verbruik-${d}${this._fileTag()}-per-uur.csv`, [
      ["Datum", "Uur", ...meters.map((m) => `${m.name} (kWh)`), "Totaal (kWh)", "Tarief (EUR/kWh)", "Kost (EUR)"],
      ...hours.map((h) => { const t = Object.values(h.meters).reduce((a, b) => a + b, 0);
        return [d, f.time(h.ts), ...meters.map((m) => csvNum(h.meters[m.id])), csvNum(t), csvNum(res.price, 5), csvNum(res.price != null ? t * res.price : null, 4)]; })]));
    body.querySelector("#csvq").addEventListener("click", () => csvDownload(`verbruik-${d}${this._fileTag()}-per-kwartier.csv`, [
      ["Datum", "Kwartier", ...meters.map((m) => `${m.name} (kWh)`), "Totaal (kWh)", "Vermogen (kW)"],
      ...quarters.map((q) => { const t = Object.values(q.meters).reduce((a, b) => a + b, 0);
        return [d, `${f.time(q.ts)}-${f.time(q.ts + 900)}`, ...meters.map((m) => csvNum(q.meters[m.id])), csvNum(t), csvNum(t * 4)]; })]));
    // tabel per uur
    const ht = body.querySelector("#htab");
    ht.innerHTML = hours.length ? `<table><thead><tr><th>Uur</th>${meters.map((m) => `<th class="num">${esc(m.name)}</th>`).join("")}<th class="num">Totaal</th><th class="num">Kost</th></tr></thead><tbody>
      ${hours.map((h) => { const t = Object.values(h.meters).reduce((a, b) => a + b, 0);
        return `<tr><td style="white-space:nowrap">${f.time(h.ts)}<span class="muted"> tot ${f.time(h.ts + 3600)}</span>${h.estimated ? EST_MARK : ""}</td>${meters.map((m) => `<td class="num">${kwh(h.meters[m.id], 2)}</td>`).join("")}<td class="num">${kwh(t, 2)}</td><td class="num">${res.price != null ? eur(t * res.price) : "-"}</td></tr>`; }).join("")}
      </tbody><tfoot><tr><td>Totaal</td>${meters.map((m) => `<td class="num">${kwh(tot[m.id], 2)}</td>`).join("")}<td class="num">${kwh(total, 2)}</td><td class="num">${eur(cost)}</td></tr></tfoot></table>`
      : `<div class="empty">Geen verbruik gekend voor deze dag.</div>`;
    if (hours.some((h) => h.estimated)) ht.insertAdjacentHTML("beforeend", `<div class="note">${EST_NOTE}</div>`);
    this._drawDay(res);
    this._drawPhases(res);
  }
  _drawDay(res) {
    const el = this.shadowRoot.getElementById("cday");
    if (!el) return;
    const f = this._fmt, c = this._colors, meters = res.meters;
    const quarter = this._res === "quarter" && res.quarters.length;
    const step = quarter ? 900 : 3600;
    const slots = []; for (let t = res.start; t < res.end; t += step) slots.push(t);   // 23 of 25 uur bij zomer- en wintertijd
    const map = Object.fromEntries((quarter ? res.quarters : res.hours).map((x) => [x.ts, x.meters]));
    barChart(el, {
      labels: slots.map((t) => (quarter ? f.time(t) : f.time(t).slice(0, 2) + "u")),
      every: quarter ? 8 : 2,
      unit: quarter ? "kW" : "kWh",
      series: meters.map((m, i) => ({ name: m.name, color: c[this._meterIndex(m.id) % c.length], values: slots.map((t) => (map[t] ? (map[t][m.id] || 0) * (quarter ? 4 : 1) : 0)) })),
      tip: (i) => { const t = slots[i], per = map[t];
        if (!per) return `<b>${f.time(t)} tot ${f.time(t + step)}</b><br>geen gegevens`;
        const s = Object.values(per).reduce((a, b) => a + b, 0);
        return `<b>${f.time(t)} tot ${f.time(t + step)}</b><br>${kwh(s, 3)}${quarter ? `, gemiddeld ${kw(s * 4)}` : ""}${res.price != null ? `, ${eur(s * res.price)}` : ""}<br>${this._meterSplit(meters, per, (v) => kwh(v, 3))}`; },
    });
  }
  _drawPhases(res) {
    const el = this.shadowRoot.getElementById("cph"), tab = this.shadowRoot.getElementById("phtab");
    if (!el) return;
    const f = this._fmt, c = this._colors, kind = this._phKind;
    const ph = res.phases[this._phMeter] || {};
    const conv = kind === "power" ? (v) => (v == null ? null : v / 1000) : (v) => v;
    const unit = { power: "kW", current: "A", voltage: "V" }[kind];
    const series = ["1", "2", "3"].map((p, i) => ({ name: `L${p}`, color: c[i], points: ((ph[p] || {})[kind] || []).map((r) => [r[0], conv(r[1])]) }));
    lineChart(el, {
      series, x0: res.start, x1: res.end, unit, zeroBase: kind !== "voltage",
      xlabel: (t) => f.time(t).slice(0, 2) + "u",
      tip: (t) => `<b>${f.time(t)}</b><br>${series.map((s) => { const p = s.points.find((x) => x[0] === t);
        return `${s.name}: <b>${p && p[1] != null ? (kind === "power" ? N2 : N1).format(p[1]) : "-"} ${unit}</b>`; }).join("<br>")}`,
    });
    const agg = (rows, i, fn) => { const v = (rows || []).map((r) => r[i]).filter((x) => x != null); return v.length ? fn(...v) : null; };
    tab.innerHTML = `<table><thead><tr><th>Fase</th><th class="num">Verbruik</th><th class="num">Max vermogen</th><th class="num">Max stroom</th><th class="num">Spanning min</th><th class="num">Spanning max</th></tr></thead><tbody>
      ${["1", "2", "3"].map((p, i) => { const x = ph[p] || {}; const pw = agg(x.power, 2, Math.max), a = agg(x.current, 2, Math.max), vmin = agg(x.voltage, 3, Math.min), vmax = agg(x.voltage, 2, Math.max);
        return `<tr><td><i class="sw" style="background:${c[i]}"></i> L${p}</td><td class="num">${kwh(x.kwh, 2)}</td><td class="num">${pw != null ? kw(pw / 1000) : "-"}</td>
          <td class="num">${a != null ? `${N1.format(a)} A` : "-"}</td><td class="num">${vmin != null ? `${N0.format(vmin)} V` : "-"}</td><td class="num">${vmax != null ? `${N0.format(vmax)} V` : "-"}</td></tr>`; }).join("")}
      </tbody></table>`;
  }

  /* ---------------- periode ---------------- */
  _range() {
    const t = this._today(), p = this._period;
    switch (p.preset) {
      case "prevmonth": return [D.prevMonthStart(t), D.add(D.monthStart(t), -1)];
      case "30": return [D.add(t, -29), t];
      case "year": return [t.slice(0, 4) + "-01-01", t];
      case "prevyear": { const y = Number(t.slice(0, 4)) - 1; return [`${y}-01-01`, `${y}-12-31`]; }
      case "custom": return [p.from || D.add(t, -29), p.to || t];
      default: return [D.monthStart(t), t];
    }
  }
  async _periodView(seq) {
    const body = this.shadowRoot.getElementById("body");
    let [a, b] = this._range();
    if (b < a) [a, b] = [b, a];
    const res = await this._ws({ type: `${DOMAIN}/days`, start: a, end: b, ...this._selArg() });
    if (seq !== this._seq) return;
    this._setAll(res.all_meters);
    const meters = res.meters, c = this._colors, p = this._period, f = this._fmt;
    // groeperen per dag, week of maand
    const key = (d) => (p.group === "month" ? d.slice(0, 7) : p.group === "week" ? D.monday(d) : d);
    const groups = new Map();
    for (const x of res.days) {
      const k = key(x.date);
      const g = groups.get(k) || { key: k, kwh: 0, cost: 0, per: {}, days: 0, peak: null, prices: new Set() };
      g.kwh += x.total; g.cost += x.cost || 0; g.days++;
      if (x.price != null) g.prices.add(x.price);
      if (x.estimated) g.est = true;
      for (const [m, v] of Object.entries(x.meters)) g.per[m] = (g.per[m] || 0) + v;
      if (x.peak && (!g.peak || x.peak.kw > g.peak.kw)) g.peak = x.peak;
      groups.set(k, g);
    }
    const list = [...groups.values()].sort((x, y) => (x.key < y.key ? -1 : 1));
    const tot = list.reduce((s, g) => ({ kwh: s.kwh + g.kwh, cost: s.cost + g.cost }), { kwh: 0, cost: 0 });
    const top = res.days.reduce((m, x) => (!m || x.total > m.total ? x : m), null);
    const peak = res.days.reduce((m, x) => (x.peak && (!m || x.peak.kw > m.kw) ? x.peak : m), null);
    const label = (g) => (p.group === "month" ? monthLabel(g.key + "-01") : p.group === "week" ? `week ${D.week(g.key)} (${dayLabel(g.key)})` : dayLabel(g.key));
    const short = (g) => (p.group === "month" ? monthShort(g.key) : p.group === "week" ? `w${D.week(g.key)}` : `${Number(g.key.slice(8))}/${Number(g.key.slice(5, 7))}`);
    body.innerHTML = `
      <div class="bar">
        <select id="preset" aria-label="Periode">${PRESETS.map(([k, l]) => `<option value="${k}" ${p.preset === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <span id="custom" style="display:${p.preset === "custom" ? "contents" : "none"}"><input type="date" id="from" value="${a}" max="${this._today()}" aria-label="Van">
          <input type="date" id="to" value="${b}" max="${this._today()}" aria-label="Tot"></span>
        <select id="group" aria-label="Groeperen"><option value="day" ${p.group === "day" ? "selected" : ""}>Per dag</option><option value="week" ${p.group === "week" ? "selected" : ""}>Per week</option><option value="month" ${p.group === "month" ? "selected" : ""}>Per maand</option></select>
        <label class="muted">Dag opzoeken <input type="date" id="find" max="${this._today()}" aria-label="Dag opzoeken"></label>
        <span style="flex:1"></span><button class="btn" id="csv">CSV</button>
      </div>
      <div class="muted" style="margin:-4px 0 10px">${dayLabel(a)} tot en met ${dayLabel(b)}</div>
      <div class="kpis">
        <div class="kpi"><div class="l">Verbruik</div><div class="v">${kwh(tot.kwh)}</div><div class="l">${res.days.length} dagen met gegevens</div></div>
        <div class="kpi"><div class="l">Kost</div><div class="v">${eur(tot.cost)}</div><div class="l">${res.days.length ? `gemiddeld ${eur(tot.cost / res.days.length)} per dag` : ""}</div></div>
        <div class="kpi"><div class="l">Gemiddeld per dag</div><div class="v">${res.days.length ? kwh(tot.kwh / res.days.length) : "-"}</div></div>
        <div class="kpi ${top ? "click" : ""}" ${top ? `data-day="${top.date}"` : ""}><div class="l">Hoogste dag</div><div class="v">${top ? kwh(top.total) : "-"}</div><div class="l">${top ? `${dayLabel(top.date)}, ${eur(top.cost)}` : ""}</div></div>
        <div class="kpi ${peak ? "click" : ""}" ${peak ? `data-day="${f.isoOf(peak.ts)}"` : ""}><div class="l">Hoogste kwartierpiek</div><div class="v">${peak ? kw(peak.kw) : "-"}</div><div class="l">${peak ? esc(f.dateTime(peak.ts)) : ""}</div></div>
      </div>
      ${this._legend(meters)}<div class="chart" id="cper"></div>
      <div class="scroll"><table><thead><tr><th>${p.group === "month" ? "Maand" : p.group === "week" ? "Week" : "Dag"}</th>${meters.map((m) => `<th class="num">${esc(m.name)}</th>`).join("")}
        <th class="num">Totaal</th><th class="num">Tarief</th><th class="num">Kost</th><th class="num">Kwartierpiek</th></tr></thead><tbody>
        ${list.slice().reverse().map((g) => `<tr><td>${p.group === "day" ? `<button class="link" data-day="${g.key}">${label(g)}</button>` : esc(label(g))}${g.est ? EST_MARK : ""}</td>
          ${meters.map((m) => `<td class="num">${kwh(g.per[m.id], p.group === "day" ? 2 : 1)}</td>`).join("")}<td class="num">${kwh(g.kwh, p.group === "day" ? 2 : 1)}</td>
          <td class="num">${g.prices.size === 1 ? EUR4.format([...g.prices][0]) : g.prices.size ? "meerdere" : "-"}</td><td class="num">${eur(g.cost)}</td>
          <td class="num">${g.peak ? `<button class="link" data-day="${f.isoOf(g.peak.ts)}" title="${esc(f.dateTime(g.peak.ts))}">${kw(g.peak.kw)}</button>` : "-"}</td></tr>`).join("") || `<tr><td colspan="9" class="empty">Geen gegevens in deze periode.</td></tr>`}
      </tbody>${list.length ? `<tfoot><tr><td>Totaal</td>${meters.map((m) => `<td class="num">${kwh(list.reduce((s, g) => s + (g.per[m.id] || 0), 0))}</td>`).join("")}<td class="num">${kwh(tot.kwh)}</td><td></td><td class="num">${eur(tot.cost)}</td><td class="num">${peak ? kw(peak.kw) : ""}</td></tr></tfoot>` : ""}</table></div>
      ${list.some((g) => g.est) ? `<div class="note">${EST_NOTE}</div>` : ""}
      <div class="note">Met Dag opzoeken open je meteen een dag met verbruik en prijs per uur. Gegevens zijn beschikbaar vanaf de eerste dag dat de meters in Home Assistant zaten.</div>`;
    const set = (k, v) => { this._period[k] = v; this._show(); };
    body.querySelector("#preset").addEventListener("change", (e) => {
      if (e.target.value === "custom") { this._period.from = a; this._period.to = b; }
      set("preset", e.target.value);
    });
    body.querySelector("#group").addEventListener("change", (e) => set("group", e.target.value));
    body.querySelector("#from").addEventListener("change", (e) => e.target.value && set("from", e.target.value));
    body.querySelector("#to").addEventListener("change", (e) => e.target.value && set("to", e.target.value));
    body.querySelector("#find").addEventListener("change", (e) => e.target.value && this._goDay(e.target.value));
    body.querySelectorAll("[data-day]").forEach((e) => e.addEventListener("click", () => this._goDay(e.dataset.day)));
    body.querySelector("#csv").addEventListener("click", () => csvDownload(`verbruik-${a}-tot-${b}${this._fileTag()}-${p.group === "month" ? "per-maand" : p.group === "week" ? "per-week" : "per-dag"}.csv`, [
      [p.group === "month" ? "Maand" : p.group === "week" ? "Week vanaf" : "Datum", ...meters.map((m) => `${m.name} (kWh)`), "Totaal (kWh)", "Tarief (EUR/kWh)", "Kost (EUR)", "Kwartierpiek (kW)", "Piek op"],
      ...list.map((g) => [p.group === "month" ? g.key : g.key.split("-").reverse().join("/"), ...meters.map((m) => csvNum(g.per[m.id])), csvNum(g.kwh),
        g.prices.size === 1 ? csvNum([...g.prices][0], 5) : "", csvNum(g.cost, 2), g.peak ? csvNum(g.peak.kw) : "", g.peak ? f.dateTime(g.peak.ts) : ""])]));
    barChart(body.querySelector("#cper"), {
      labels: list.map(short),
      series: meters.map((m, i) => ({ name: m.name, color: c[this._meterIndex(m.id) % c.length], values: list.map((g) => g.per[m.id] || 0) })),
      tip: (i) => { const g = list[i]; return `<b>${esc(label(g))}</b><br>${kwh(g.kwh, p.group === "day" ? 2 : 1)}, ${eur(g.cost)}<br>${this._meterSplit(meters, g.per)}`; },
      onClick: p.group === "day" ? (i) => this._goDay(list[i].key) : null,
    });
  }

  /* ---------------- pieken ---------------- */
  async _peaksView(seq) {
    const res = await this._ws({ type: `${DOMAIN}/peaks`, ...this._selArg() });
    if (seq !== this._seq) return;
    this._setAll(res.all_meters);
    const body = this.shadowRoot.getElementById("body"), f = this._fmt, c = this._colors;
    const cur = this._today().slice(0, 7);
    const mp = res.months.find((m) => m.month === cur);
    const meters = res.meters;
    body.innerHTML = `
      <div class="kpis">
        <div class="kpi ${mp ? "click" : ""}" ${mp ? `data-day="${f.isoOf(mp.ts)}"` : ""}><div class="l">Piek deze maand</div><div class="v">${mp ? kw(mp.kw) : "-"}</div><div class="l">${mp ? esc(f.dateTime(mp.ts)) : "nog geen gegevens"}</div></div>
        <div class="kpi"><div class="l">Facturatiepiek (indicatie)</div><div class="v">${res.billing_peak != null ? kw(res.billing_peak) : "-"}</div><div class="l">gemiddelde van ${Math.min(12, res.months.length)} maand${res.months.length === 1 ? "" : "en"}, minimum 2,5 kW per maand</div></div>
        <div class="kpi"><div class="l">Kwartiergegevens sinds</div><div class="v" style="font-size:1rem">${res.since ? esc(f.dateTime(res.since)) : "-"}</div></div>
      </div>
      <h3>Maandpiek</h3><div class="chart" id="cpk"></div>
      <div class="scroll"><table><thead><tr><th>Maand</th><th class="num">Maandpiek</th><th>Wanneer</th><th class="num">Telt mee als</th></tr></thead><tbody>
        ${res.months.slice().reverse().map((m) => `<tr><td>${monthLabel(m.month + "-01")}</td><td class="num">${kw(m.kw)}</td>
          <td><button class="link" data-day="${f.isoOf(m.ts)}">${esc(f.dateTime(m.ts))}</button></td><td class="num">${kw(Math.max(m.kw, 2.5))}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">Nog geen kwartiergegevens.</td></tr>`}
      </tbody></table></div>
      <h3>Hoogste kwartieren deze maand</h3>
      <div class="scroll"><table><thead><tr><th>Kwartier</th>${meters.map((m) => `<th class="num">${esc(m.name)}</th>`).join("")}<th class="num">Totaal</th></tr></thead><tbody>
        ${res.top.map((t) => `<tr><td><button class="link" data-day="${f.isoOf(t.ts)}">${esc(f.dateTime(t.ts))} tot ${f.time(t.ts + 900)}</button></td>
          ${meters.map((m) => `<td class="num">${kw(t.meters[m.id])}</td>`).join("")}<td class="num">${kw(t.kw)}</td></tr>`).join("") || `<tr><td colspan="9" class="empty">Nog geen kwartiergegevens deze maand.</td></tr>`}
      </tbody></table></div>
      <div class="note">De maandpiek is het hoogste gemiddelde vermogen over een kwartier in die maand, voor alle meters samen (een aansluiting).
        Fluvius rekent het capaciteitstarief op het gemiddelde van de maandpieken van de laatste 12 maanden, met minimum 2,5 kW per maand.
        Deze waarden zijn een benadering: de meters melden hun stand via de cloud elke 1 tot 6 minuten. De officiele piek staat in Mijn Fluvius.</div>`;
    body.querySelectorAll("[data-day]").forEach((e) => e.addEventListener("click", () => this._goDay(e.dataset.day)));
    const list = res.months;
    if (list.length) {
      barChart(body.querySelector("#cpk"), {
        labels: list.map((m) => monthShort(m.month + "-01")), unit: "kW", refLine: 2.5,
        series: [{ name: "Maandpiek", color: c[0], values: list.map((m) => m.kw) }],
        tip: (i) => `<b>${monthLabel(list[i].month + "-01")}</b><br>${kw(list[i].kw)}<br>${esc(f.dateTime(list[i].ts))}`,
        onClick: (i) => this._goDay(f.isoOf(list[i].ts)),
      });
    } else {
      body.querySelector("#cpk").innerHTML = `<div class="empty">Nog geen kwartiergegevens.</div>`;
    }
  }

  /* ---------------- evenementen ---------------- */
  async _eventsView(seq) {
    const body = this.shadowRoot.getElementById("body");
    if (!this._isAdmin) { body.innerHTML = `<div class="note">Evenementen zijn enkel zichtbaar voor beheerders.</div>`; return; }
    if (this._evOpen) return this._eventForm(seq);
    const res = await this._ws({ type: `${DOMAIN}/events` });
    if (seq !== this._seq) return;
    this._setAll(res.meters);
    this._evMeta = res;
    const names = Object.fromEntries(res.meters.map((m) => [m.id, m.name]));
    const when = (iso) => this._isoLabel(iso);
    body.innerHTML = `
      <div class="bar"><button class="btn primary" id="evnew">Nieuw evenement</button><span style="flex:1"></span>
        <input type="search" id="evq" placeholder="Zoek evenement of organisator" value="${esc(this._evQ || "")}" style="min-width:220px"></div>
      <div class="scroll"><table><thead><tr><th>Referentie</th><th>Evenement</th><th>Organisator</th><th>Periode</th><th>Meters</th>
        <th class="num">Verbruik</th><th class="num">Bedrag</th><th></th></tr></thead><tbody id="evrows"></tbody></table></div>
      <div class="note">Een evenement is een periode (van datum en uur tot datum en uur) op een of meer meters. Het verbruik wordt per kwartier opgeteld; begin en einde worden afgerond op het volle kwartier. De PDF is een afrekening op naam van TrefpuntFestival vzw met plaats voor handtekeningen.</div>`;
    const draw = () => {
      const q = (this._evQ || "").toLowerCase();
      const list = res.events.filter((e) => !q || `${e.name} ${e.organizer || ""} ${e.number}`.toLowerCase().includes(q));
      body.querySelector("#evrows").innerHTML = list.map((e) => `<tr>
        <td style="white-space:nowrap">${esc(e.number)}</td><td><button class="link" data-ev="${esc(e.id)}">${esc(e.name)}</button></td>
        <td>${esc(e.organizer || "")}</td><td style="white-space:nowrap">${when(e.start)}<br><span class="muted">tot ${when(e.end)}</span></td>
        <td>${(e.meters || []).map((m) => esc(names[m] || m)).join(", ")}</td>
        <td class="num">${e.error ? `<span class="error" title="${esc(e.error)}">fout</span>` : e.not_started ? '<span class="muted">nog niet begonnen</span>' : e.total != null ? kwh(e.total, 2) + (e.ongoing ? '<br><span class="muted">loopt nog</span>' : "") : "-"}</td>
        <td class="num">${e.amount != null && !e.error ? eur(e.amount) : "-"}</td>
        <td class="num" style="white-space:nowrap"><button class="btn" data-pdf="${esc(e.id)}">PDF</button>
          <button class="btn" data-del="${esc(e.id)}" data-name="${esc(e.number)}" title="Evenement verwijderen">Verwijderen</button></td></tr>`).join("")
        || `<tr><td colspan="8" class="empty">${res.events.length ? "Niets gevonden." : "Nog geen evenementen. Maak er een met Nieuw evenement."}</td></tr>`;
      body.querySelectorAll("[data-ev]").forEach((b) => b.addEventListener("click", () => { this._evOpen = b.dataset.ev; this._show(); }));
      body.querySelectorAll("[data-pdf]").forEach((b) => b.addEventListener("click", () => this._pdf(b.dataset.pdf, b)));
      body.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
        // twee klikken: eerst bevestigen
        if (b.dataset.sure !== "1") {
          b.dataset.sure = "1"; b.textContent = `Zeker ${b.dataset.name} verwijderen?`; b.classList.add("danger");
          setTimeout(() => { if (b.isConnected && b.dataset.sure === "1") { b.dataset.sure = ""; b.textContent = "Verwijderen"; b.classList.remove("danger"); } }, 6000);
          return;
        }
        b.disabled = true;
        try { await this._ws({ type: `${DOMAIN}/event/delete`, event_id: b.dataset.del }); this._evMeta = null; this._show(); }
        catch (err) { b.disabled = false; b.textContent = `Niet gelukt: ${errText(err)}`; }
      }));
    };
    draw();
    body.querySelector("#evq").addEventListener("input", (e) => { this._evQ = e.target.value; draw(); });
    body.querySelector("#evnew").addEventListener("click", () => { this._evOpen = "new"; this._show(); });
  }
  _isoLabel(iso) {
    // "2026-09-19T19:07+02:00" -> "Za 19 sep 2026, 19u07" (de tijd staat al in de tijdzone van Home Assistant)
    if (!iso) return "-";
    return `${dayLabel(iso.slice(0, 10))}, ${iso.slice(11, 13)}u${iso.slice(14, 16)}`;
  }
  async _pdf(id, btn) {
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "PDF maken..."; }
    try {
      const r = await this._hass.fetchWithAuth(`/api/btechnics_energie/evenement/${encodeURIComponent(id)}/pdf`);
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const blob = await r.blob();
      const name = (/filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "") || [])[1] || "afrekening.pdf";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    } catch (e) {
      const m = this.shadowRoot.getElementById("evmsg");
      const txt = `PDF maken mislukt: ${errText(e)}`;
      if (m) { m.className = "msg error"; m.textContent = txt; } else if (btn) btn.title = txt;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old; }
    }
  }
  async _eventForm(seq) {
    const body = this.shadowRoot.getElementById("body");
    const meta = this._evMeta || await this._ws({ type: `${DOMAIN}/events` });
    if (seq !== this._seq) return;
    this._evMeta = meta;
    this._setAll(meta.meters);
    const isNew = this._evOpen === "new";
    const ev = isNew ? null : meta.events.find((e) => e.id === this._evOpen);
    if (!isNew && !ev) { this._evOpen = null; return this._show(); }
    const today = this._today();
    const e = ev || { name: "", organizer: "", contact: "", start: `${today}T19:00`, end: `${today}T23:00`, meters: [meta.meters[0] && meta.meters[0].id], price: null, note: "" };
    const tariff = (() => { const d = (e.start || today).slice(0, 10); let p = null;
      for (const t of (meta.tariffs || []).slice().sort((a, b) => (a.from < b.from ? -1 : 1))) if (t.from <= d || p == null) p = t.price; return p; })();
    body.innerHTML = `
      <div class="bar"><button class="btn" id="evback">&lsaquo; Alle evenementen</button><span class="daytitle">${isNew ? "Nieuw evenement" : `${esc(e.number)} ${esc(e.name)}`}</span></div>
      <div class="panel">
        <div class="row"><label style="flex:1 1 260px">Naam van het evenement *<br><input id="f_name" type="text" value="${esc(e.name)}" style="width:100%" maxlength="200"></label>
          <label style="flex:1 1 220px">Organisator<br><input id="f_org" type="text" value="${esc(e.organizer || "")}" style="width:100%" maxlength="200"></label>
          <label style="flex:1 1 220px">Contact (naam, telefoon of e-mail)<br><input id="f_contact" type="text" value="${esc(e.contact || "")}" style="width:100%" maxlength="300"></label></div>
        <div class="row"><label>Begin<br><input id="f_start" type="datetime-local" value="${esc((e.start || "").slice(0, 16))}"></label>
          <label>Einde<br><input id="f_end" type="datetime-local" value="${esc((e.end || "").slice(0, 16))}"></label>
          <label>Prijs per kWh (EUR)<br><input id="f_price" type="number" step="0.0001" min="0" max="5" inputmode="decimal" style="width:150px"
            value="${e.price != null ? e.price : ""}" placeholder="${tariff != null ? String(tariff).replace(".", ",") + " (tarief)" : ""}"></label>
          <span>Meters<br>${meta.meters.map((m) => `<label style="margin-right:12px;white-space:nowrap"><input type="checkbox" class="f_m" value="${esc(m.id)}" ${(e.meters || []).includes(m.id) ? "checked" : ""}> ${esc(m.name)}</label>`).join("")}</span></div>
        <div class="row"><label style="flex:1">Opmerking (komt op de PDF)<br><textarea id="f_note" rows="2" maxlength="2000" style="width:100%;font:inherit;box-sizing:border-box;border:1px solid var(--divider-color);border-radius:8px;padding:8px;background:var(--card-background-color);color:var(--primary-text-color)">${esc(e.note || "")}</textarea></label></div>
        <div class="row"><button class="btn primary" id="evsave">Opslaan</button>
          <button class="btn" id="evpdf" ${isNew ? "disabled title=\"Eerst opslaan\"" : ""}>PDF</button>
          ${isNew ? "" : `<button class="btn" id="evdel">Verwijderen</button>`}<span id="evmsg" class="msg"></span></div>
        <div class="note">Laat de prijs leeg om het tarief van die dag te gebruiken${tariff != null ? ` (nu ${EUR4.format(tariff)} per kWh)` : ""}.</div>
      </div>
      <div id="evrep"><div class="muted">Berekenen...</div></div>`;
    const $ = (id) => body.querySelector(id);
    const msg = $("#evmsg");
    const form = () => {
      const price = String($("#f_price").value).trim().replace(",", ".");
      return { name: $("#f_name").value.trim(), organizer: $("#f_org").value.trim(), contact: $("#f_contact").value.trim(),
        start: $("#f_start").value, end: $("#f_end").value, meters: [...body.querySelectorAll(".f_m:checked")].map((x) => x.value),
        price: price === "" ? null : Number(price), note: $("#f_note").value };
    };
    const check = (d, forSave) => {
      if (forSave && !d.name) return "Geef het evenement een naam.";
      if (!d.start || !d.end) return "Kies een begin en een einde.";
      if (d.end <= d.start) return "Het einde moet na het begin liggen.";
      if (!d.meters.length) return "Kies minstens een meter.";
      if (d.price != null && !(Number.isFinite(d.price) && d.price >= 0 && d.price <= 5)) return "Prijs per kWh tussen 0 en 5 EUR.";
      return null;
    };
    const calc = async () => {
      const d = form(), err = check(d, false);
      const rep = $("#evrep");
      if (err) { rep.innerHTML = `<div class="note">${esc(err)}</div>`; return; }
      const my = (this._evCalc = (this._evCalc || 0) + 1);
      try {
        const r = await this._ws({ type: `${DOMAIN}/event/report`, draft: { ...d, name: d.name || "Evenement" } });
        if (my === this._evCalc && this.isConnected) this._drawEventReport(rep, r);
      } catch (e2) { if (my === this._evCalc) rep.innerHTML = `<div class="error">${esc(errText(e2))}</div>`; }
    };
    let deb;
    body.querySelectorAll("input, textarea").forEach((x) => x.addEventListener(x.type === "text" || x.tagName === "TEXTAREA" ? "change" : "input",
      () => { clearTimeout(deb); deb = setTimeout(calc, 400); }));
    $("#evback").addEventListener("click", () => { this._evOpen = null; this._evMeta = null; this._show(); });
    $("#evsave").addEventListener("click", async () => {
      const d = form(), err = check(d, true);
      if (err) { msg.className = "msg error"; msg.textContent = err; return; }
      $("#evsave").disabled = true;
      try {
        const r = await this._ws({ type: `${DOMAIN}/event/save`, ...(isNew ? {} : { event_id: ev.id }), ...d });
        this._evOpen = r.event.id;
        this._evMeta = null;
        await this._show();
        const m2 = this.shadowRoot.getElementById("evmsg");
        if (m2) { m2.className = "msg ok"; m2.textContent = "Opgeslagen"; }
      } catch (e2) { msg.className = "msg error"; msg.textContent = `Niet gelukt: ${errText(e2)}`; $("#evsave").disabled = false; }
    });
    if (!isNew) {
      $("#evpdf").addEventListener("click", () => this._pdf(ev.id, $("#evpdf")));
      $("#evdel").addEventListener("click", async () => {
        if ($("#evdel").dataset.sure !== "1") { $("#evdel").dataset.sure = "1"; $("#evdel").textContent = "Zeker verwijderen?"; return; }
        try { await this._ws({ type: `${DOMAIN}/event/delete`, event_id: ev.id }); this._evOpen = null; this._evMeta = null; this._show(); }
        catch (e2) { msg.className = "msg error"; msg.textContent = `Niet gelukt: ${errText(e2)}`; }
      });
    }
    calc();
  }
  _drawEventReport(el, r) {
    const f = this._fmt, c = this._colors;
    const meters = r.meters;
    const mins = Math.round((r.to - r.from) / 60);
    el.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="l">Verbruik${r.ongoing ? " (loopt nog)" : ""}</div><div class="v">${kwh(r.total, 2)}</div><div class="l">${f.dateTime(r.from)} tot ${f.time(r.to)}${f.isoOf(r.to - 1) !== f.isoOf(r.from) ? ` (${dayLabel(f.isoOf(r.to - 1))})` : ""}</div></div>
        <div class="kpi"><div class="l">Prijs per kWh</div><div class="v">${r.price != null ? EUR4.format(r.price) : "-"}</div><div class="l">${r.event.price != null ? "eigen prijs" : "tarief van die dag"}</div></div>
        <div class="kpi"><div class="l">Bedrag</div><div class="v">${eur(r.amount)}</div><div class="l">zoals op de PDF</div></div>
        <div class="kpi"><div class="l">Duur</div><div class="v">${Math.floor(mins / 60)}u${two(mins % 60)}</div><div class="l">afgerond op het ${r.resolution}</div></div>
        <div class="kpi"><div class="l">Kwartierpiek</div><div class="v">${r.peak ? kw(r.peak.kw) : "-"}</div><div class="l">${r.peak ? f.time(r.peak.ts) + " tot " + f.time(r.peak.ts + 900) : ""}</div></div>
      </div>
      <div class="scroll"><table><thead><tr><th>Meter</th><th class="num">Meterstand begin</th><th class="num">Meterstand einde</th><th class="num">Verbruik</th><th class="num">Bedrag</th></tr></thead><tbody>
        ${meters.map((m) => `<tr><td><i class="sw" style="background:${c[this._meterIndex(m.id) % c.length]}"></i> ${esc(m.name)}</td>
          <td class="num">${m.begin != null ? kwh(m.begin, 2) : "-"}</td><td class="num">${m.end != null ? kwh(m.end, 2) : "-"}</td>
          <td class="num">${kwh(m.kwh, 2)}</td><td class="num">${r.price != null ? eur(m.kwh * r.price) : "-"}</td></tr>`).join("")}
      </tbody>${meters.length > 1 ? `<tfoot><tr><td>Totaal</td><td></td><td></td><td class="num">${kwh(r.total, 2)}</td><td class="num">${eur(r.amount)}</td></tr></tfoot>` : ""}</table></div>
      <h3>Verloop per ${r.resolution}</h3>${this._legend(meters)}<div class="chart" id="evchart"></div>
      <div class="note">${r.ongoing ? `<b>Het evenement loopt nog:</b> gemeten tot ${f.dateTime(r.to)}. ` : ""}${r.resolution === "kwartier" ? "Som van de kwartierwaarden tussen begin en einde, afgerond op het volle kwartier."
        : "Voor deze periode zijn er geen kwartierwaarden; het verbruik is per uur opgeteld, begin en einde afgerond op het volle uur."}
        ${(r.estimated_hours || []).length ? ` Voor ${r.estimated_hours.length} uur ontbraken kwartierwaarden (Home Assistant stond uit); die kwartieren zijn geschat uit het uurverbruik.` : ""}
        ${(r.missing_hours || []).length ? ` <b>Voor ${r.missing_hours.length} uur zijn er geen meetgegevens;</b> dat verbruik ontbreekt.` : ""}
        ${r.not_started ? " <b>Het evenement is nog niet begonnen.</b>" : ""}
        De meterstanden zijn de stand van de meter (som van de drie fasen) op dat moment.</div>`;
    const quarter = r.step === 900;
    barChart(el.querySelector("#evchart"), {
      labels: r.series.map((x) => f.time(x.ts)), unit: quarter ? "kW" : "kWh", every: quarter ? 4 : 1,
      series: meters.map((m) => ({ name: m.name, color: c[this._meterIndex(m.id) % c.length], values: r.series.map((x) => (x.meters[m.id] || 0) * (quarter ? 4 : 1)) })),
      tip: (i) => { const x = r.series[i]; const sum = Object.values(x.meters).reduce((a, b) => a + b, 0);
        return `<b>${f.dateTime(x.ts)} tot ${f.time(x.ts + r.step)}</b><br>${kwh(sum, 3)}${quarter ? `, gemiddeld ${kw(sum * 4)}` : ""}${x.estimated ? " (uit uurwaarde)" : ""}<br>${this._meterSplit(meters, x.meters, (v) => kwh(v, 3))}`; },
    });
  }

  /* ---------------- handleiding ---------------- */
  async _helpView() {
    const body = this.shadowRoot.getElementById("body");
    body.innerHTML = helpHtml(HELP_DOC);
    wireHelp(body, HELP_DOC, (tab) => { this._tab = tab; this._renderTabs(); this._show(); });
    if (this._isAdmin) errorLogSection(body, this._hass, DOMAIN, (ts) => this._fmt.dateTime(ts));
  }

  /* ---------------- tarieven ---------------- */
  async _tariffView(seq) {
    const res = await this._ws({ type: `${DOMAIN}/days`, start: this._today(), end: this._today() });
    if (seq !== this._seq) return;
    const items = (res.tariffs || []).slice().sort((a, b) => (a.from < b.from ? 1 : -1));
    const body = this.shadowRoot.getElementById("body");
    const admin = this._isAdmin;
    const cur = items.find((i) => i.from <= this._today()) || items[items.length - 1];
    body.innerHTML = `
      <div class="kpis"><div class="kpi"><div class="l">Tarief vandaag</div><div class="v">${cur ? `${EUR4.format(cur.price)}` : "-"}</div><div class="l">per kWh, all-in</div></div></div>
      <div class="scroll"><table><thead><tr><th>Geldt vanaf</th><th class="num">Prijs per kWh</th><th></th></tr></thead><tbody>
        ${items.map((i, n) => `<tr><td>${i.from <= "2000-01-01" ? "begin" : dayLabel(i.from)}</td><td class="num">${EUR4.format(i.price)}</td>
          <td class="num">${admin && items.length > 1 ? `<button class="btn" data-del="${i.from}">Verwijderen</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">Nog geen tarief ingesteld.</td></tr>`}
      </tbody></table></div>
      ${admin ? `<div class="panel"><div class="row"><b>Nieuw tarief</b></div>
        <div class="row"><label>Geldt vanaf <input type="date" id="tfrom" value="${this._today()}"></label>
          <label>Prijs per kWh (EUR) <input type="number" id="tprice" step="0.0001" min="0" max="5" inputmode="decimal" placeholder="0,3600" style="width:140px"></label>
          <button class="btn primary" id="tsave">Opslaan</button></div><div id="tmsg" class="msg"></div></div>` : `<div class="note">Enkel beheerders kunnen tarieven aanpassen.</div>`}
      <div class="note">Vul de all-in prijs per kWh in zoals op de factuur (energie, nettarieven en heffingen per kWh, inclusief btw). Een tarief geldt vanaf 00u00 op die datum tot het volgende.
        Dagen worden altijd gerekend tegen het tarief dat toen gold, ook na een wijziging. Het capaciteitstarief (per kW maandpiek) zit hier niet in; zie Pieken.</div>`;
    if (admin) {
      const msg = body.querySelector("#tmsg");
      body.querySelector("#tsave").addEventListener("click", async () => {
        const from = body.querySelector("#tfrom").value;
        const price = Number(String(body.querySelector("#tprice").value).replace(",", "."));
        if (!from || !Number.isFinite(price) || price <= 0 || price > 5) { msg.className = "msg error"; msg.textContent = "Kies een datum en een prijs tussen 0 en 5 EUR."; return; }
        try { await this._ws({ type: `${DOMAIN}/tariff/set`, from, price }); this._show(); }
        catch (e) { msg.className = "msg error"; msg.textContent = `Niet gelukt: ${errText(e)}`; }
      });
      body.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true;
        try { await this._ws({ type: `${DOMAIN}/tariff/delete`, from: b.dataset.del }); this._show(); }
        catch (e) { b.disabled = false; const m = body.querySelector("#tmsg"); if (m) { m.className = "msg error"; m.textContent = `Niet gelukt: ${errText(e)}`; } }
      }));
    }
  }
}

// Home Assistant laadt deze module soms voor de kaartregistratie klaar is: veilig definieren.
const CARD_VERSION = "0.3.4";
// Een oude kopie van de pagina (service worker) kan eerst een oudere versie van dit script laden
// (vastgesteld 26/09/2026: v0.2.2 uit de cache voor v0.3.0). Een custom element kan niet opnieuw gedefinieerd
// worden: de al geregistreerde klasse laten steunen op deze code en bestaande kaarten opnieuw opbouwen.
function upgradeCard(reg) {
  // kandidaten: de geregistreerde klasse en de klassen van de kaarten die echt op de pagina staan (met een
  // scoped registry is dat niet altijd dezelfde; vastgesteld bij Btechnics VTO op 28/09/2026)
  const cands = new Set([reg.get("btechnics-energie")]);
  const find = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.tagName === "BTECHNICS-ENERGIE") cands.add(el.constructor);
      if (el.shadowRoot) find(el.shadowRoot);
    }
  };
  find(document);
  const v = (x) => String(x || "0").split(".").map(Number);
  let changed = false;
  for (const R of cands) {
    if (!R || !R.prototype || R.prototype instanceof BtechnicsEnergieCard) continue;
    const [a, b] = [v(CARD_VERSION), v(R.__btxVersion)];
    const i = a.findIndex((n, k) => n !== (b[k] || 0));
    if (R.__btxVersion && (i < 0 || a[i] < (b[i] || 0))) continue;     // enkel naar een nieuwere versie
    try {
      Object.setPrototypeOf(R.prototype, BtechnicsEnergieCard.prototype);
      Object.setPrototypeOf(R, BtechnicsEnergieCard);
      R.__btxVersion = CARD_VERSION;
      changed = true;
    } catch (e) { /* oude versie laten staan */ }
  }
  if (!changed) return;
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.tagName === "BTECHNICS-ENERGIE" && el._hass) {
        el._fmt = makeFmt(el._hass.config && el._hass.config.time_zone);
        clearInterval(el._timer);
        el._timer = null;
        try { el._init(); } catch (e) { /* volgende kaart */ }
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
}
function register() {
  const reg = window.customElements;
  if (!reg.get("btechnics-energie")) {
    const R = class extends BtechnicsEnergieCard {};
    R.__btxVersion = CARD_VERSION;
    reg.define("btechnics-energie", R);
  }
  upgradeCard(reg);
  window.customCards = window.customCards || [];
  if (!window.customCards.find((c) => c.type === "btechnics-energie")) {
    window.customCards.push({ type: "btechnics-energie", name: "Btechnics Energie", description: "Verbruik, kost per dag, fasen en kwartierpieken" });
  }
}
register();
let registerTries = 0;
const registerTimer = setInterval(() => { try { register(); } catch (e) { /* volgende poging */ } if (++registerTries >= 60) clearInterval(registerTimer); }, 1000);
