/*
 * Btechnics Energie: dashboardkaart custom:btechnics-energie
 *   Overzicht  nu, vandaag, week, maand, jaar met kost; laatste 30 dagen
 *   Dag        een dag in detail: per uur of kwartier, per fase, kost van die dag
 *   Periode    per dag, week of maand over een gekozen periode, met CSV
 *   Pieken     kwartierpiek per maand (capaciteitstarief)
 *   Tarieven   prijs per kWh met historiek
 * Zelfde stijl als de kaarten van Btechnics VTO. Tijden in de tijdzone van Home Assistant.
 */
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
  .live { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .meter { border: 1px solid var(--divider-color); border-radius: 12px; padding: 12px; }
  .meter .head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .meter .name { font-weight: 500; }
  .meter .p { white-space: nowrap; font-size: 1.5rem; font-weight: 500; font-variant-numeric: tabular-nums; }
  .ph { display: grid; grid-template-columns: 28px 1fr auto; gap: 8px; align-items: center; font-size: 0.85rem; margin-top: 6px; }
  .ph .track { height: 8px; background: var(--secondary-background-color); border-radius: 4px; overflow: hidden; }
  .ph .fill { height: 100%; border-radius: 4px; }
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
    .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
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
    <text x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${(nice < 10 ? N1 : N0).format(v)}</text>`).join("");
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

const TABS = [["overzicht", "Overzicht"], ["dag", "Dag"], ["periode", "Periode"], ["pieken", "Pieken"], ["tarieven", "Tarieven"]];
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
    this.shadowRoot.innerHTML = `<style>${CSS}</style><ha-card>
      <div class="title">${esc(this._config.title || "Energieverbruik")}</div>
      <div class="tabs" id="tabs"></div>
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
      pieken: () => this._peaksView(seq), tarieven: () => this._tariffView(seq) }[this._tab];
    run().catch(fail);
  }
  _goDay(d) {
    this._day = d;
    this._tab = "dag";
    this._renderTabs();
    this._show();
  }

  _legend(meters) {
    const c = this._colors;
    return `<div class="legend">${meters.map((m, i) => `<span><i class="sw" style="background:${c[i % c.length]}"></i>${esc(m.name)}</span>`).join("")}</div>`;
  }
  _meterSplit(meters, per, fmt = (v) => kwh(v, 2)) {
    return meters.map((m) => `${esc(m.name)}: <b>${fmt(per[m.id])}</b>`).join("<br>");
  }

  /* ---------------- overzicht ---------------- */
  async _overview(seq) {
    const today = this._today();
    const start = [D.add(today, -40), `${Number(today.slice(0, 4)) - 1}-12-25`, D.prevMonthStart(today)].sort()[0];
    const [res, pk] = await Promise.all([this._ws({ type: `${DOMAIN}/days`, start, end: today }), this._ws({ type: `${DOMAIN}/peaks` })]);
    if (seq !== this._seq) return;
    this._ov = res;
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
      series: res.meters.map((m, i) => ({ name: m.name, color: c[i % c.length], values: days.map((d) => (byDate[d] ? byDate[d].meters[m.id] || 0 : 0)) })),
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
      return `<div class="meter"><div class="head"><span class="name"><i class="sw" style="background:${c[i % c.length]}"></i> ${esc(m.name)}</span>
        <span class="p">${ph.some((x) => x.w != null) ? kw(w / 1000) : "-"}</span></div>
        ${ph.map((x) => `<div class="ph"><span class="muted">L${x.p}</span><div class="track"><div class="fill" style="width:${Math.min(100, ((x.a || 0) / maxA) * 100)}%;background:${c[i % c.length]}"></div></div>
          <span>${x.w != null ? `${N2.format(x.w / 1000)} kW` : "-"} <span class="muted">${x.a != null ? `${N1.format(x.a)} A` : ""}${x.v != null ? `, ${N0.format(x.v)} V` : ""}</span></span></div>`).join("")}
      </div>`;
    }).join("");
    el.innerHTML = cards + (this._meters.length > 1 ? `<div class="meter"><div class="head"><span class="name">Totaal nu</span><span class="p">${any ? kw(total / 1000) : "-"}</span></div>
      <div class="note">Som van alle meters, live. Een kwartier op dit vermogen: ${any ? kwh(total / 4000, 2) : "-"}.</div></div>` : "");
  }

  /* ---------------- dag ---------------- */
  async _dayView(seq) {
    const d = this._day;
    const body = this.shadowRoot.getElementById("body");
    if (!body.querySelector("#daynav")) body.innerHTML = `<div class="muted">Laden...</div>`;
    const res = await this._ws({ type: `${DOMAIN}/day`, date: d });
    if (seq !== this._seq) return;
    this._meters = res.meters;
    const f = this._fmt, c = this._colors, meters = res.meters, today = this._today();
    const hours = res.hours, quarters = res.quarters;
    const tot = {}; let total = 0;
    hours.forEach((h) => Object.entries(h.meters).forEach(([m, v]) => { tot[m] = (tot[m] || 0) + v; total += v; }));
    let peak = null;
    quarters.forEach((q) => { const k = Object.values(q.meters).reduce((a, b) => a + b, 0) * 4; if (!peak || k > peak.kw) peak = { kw: k, ts: q.ts }; });
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
        ${meters.map((m, i) => `<div class="kpi"><div class="l"><i class="sw" style="background:${c[i % c.length]}"></i> ${esc(m.name)}</div><div class="v">${kwh(tot[m.id], 2)}</div>
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
    body.querySelector("#csvh").addEventListener("click", () => csvDownload(`verbruik-${d}-per-uur.csv`, [
      ["Datum", "Uur", ...meters.map((m) => `${m.name} (kWh)`), "Totaal (kWh)", "Tarief (EUR/kWh)", "Kost (EUR)"],
      ...hours.map((h) => { const t = Object.values(h.meters).reduce((a, b) => a + b, 0);
        return [d, f.time(h.ts), ...meters.map((m) => csvNum(h.meters[m.id])), csvNum(t), csvNum(res.price, 5), csvNum(res.price != null ? t * res.price : null, 4)]; })]));
    body.querySelector("#csvq").addEventListener("click", () => csvDownload(`verbruik-${d}-per-kwartier.csv`, [
      ["Datum", "Kwartier", ...meters.map((m) => `${m.name} (kWh)`), "Totaal (kWh)", "Vermogen (kW)"],
      ...quarters.map((q) => { const t = Object.values(q.meters).reduce((a, b) => a + b, 0);
        return [d, `${f.time(q.ts)}-${f.time(q.ts + 900)}`, ...meters.map((m) => csvNum(q.meters[m.id])), csvNum(t), csvNum(t * 4)]; })]));
    // tabel per uur
    const ht = body.querySelector("#htab");
    ht.innerHTML = hours.length ? `<table><thead><tr><th>Uur</th>${meters.map((m) => `<th class="num">${esc(m.name)}</th>`).join("")}<th class="num">Totaal</th><th class="num">Kost</th></tr></thead><tbody>
      ${hours.map((h) => { const t = Object.values(h.meters).reduce((a, b) => a + b, 0);
        return `<tr><td style="white-space:nowrap">${f.time(h.ts)}<span class="muted"> tot ${f.time(h.ts + 3600)}</span></td>${meters.map((m) => `<td class="num">${kwh(h.meters[m.id], 2)}</td>`).join("")}<td class="num">${kwh(t, 2)}</td><td class="num">${res.price != null ? eur(t * res.price) : "-"}</td></tr>`; }).join("")}
      </tbody><tfoot><tr><td>Totaal</td>${meters.map((m) => `<td class="num">${kwh(tot[m.id], 2)}</td>`).join("")}<td class="num">${kwh(total, 2)}</td><td class="num">${eur(cost)}</td></tr></tfoot></table>`
      : `<div class="empty">Geen verbruik gekend voor deze dag.</div>`;
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
      series: meters.map((m, i) => ({ name: m.name, color: c[i % c.length], values: slots.map((t) => (map[t] ? (map[t][m.id] || 0) * (quarter ? 4 : 1) : 0)) })),
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
    const res = await this._ws({ type: `${DOMAIN}/days`, start: a, end: b });
    if (seq !== this._seq) return;
    const meters = res.meters, c = this._colors, p = this._period, f = this._fmt;
    // groeperen per dag, week of maand
    const key = (d) => (p.group === "month" ? d.slice(0, 7) : p.group === "week" ? D.monday(d) : d);
    const groups = new Map();
    for (const x of res.days) {
      const k = key(x.date);
      const g = groups.get(k) || { key: k, kwh: 0, cost: 0, per: {}, days: 0, peak: null, prices: new Set() };
      g.kwh += x.total; g.cost += x.cost || 0; g.days++;
      if (x.price != null) g.prices.add(x.price);
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
        ${list.slice().reverse().map((g) => `<tr><td>${p.group === "day" ? `<button class="link" data-day="${g.key}">${label(g)}</button>` : esc(label(g))}</td>
          ${meters.map((m) => `<td class="num">${kwh(g.per[m.id], p.group === "day" ? 2 : 1)}</td>`).join("")}<td class="num">${kwh(g.kwh, p.group === "day" ? 2 : 1)}</td>
          <td class="num">${g.prices.size === 1 ? EUR4.format([...g.prices][0]) : g.prices.size ? "meerdere" : "-"}</td><td class="num">${eur(g.cost)}</td>
          <td class="num">${g.peak ? `<button class="link" data-day="${f.isoOf(g.peak.ts)}" title="${esc(f.dateTime(g.peak.ts))}">${kw(g.peak.kw)}</button>` : "-"}</td></tr>`).join("") || `<tr><td colspan="9" class="empty">Geen gegevens in deze periode.</td></tr>`}
      </tbody>${list.length ? `<tfoot><tr><td>Totaal</td>${meters.map((m) => `<td class="num">${kwh(list.reduce((s, g) => s + (g.per[m.id] || 0), 0))}</td>`).join("")}<td class="num">${kwh(tot.kwh)}</td><td></td><td class="num">${eur(tot.cost)}</td><td class="num">${peak ? kw(peak.kw) : ""}</td></tr></tfoot>` : ""}</table></div>
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
    body.querySelector("#csv").addEventListener("click", () => csvDownload(`verbruik-${a}-tot-${b}-${p.group === "month" ? "per-maand" : p.group === "week" ? "per-week" : "per-dag"}.csv`, [
      [p.group === "month" ? "Maand" : p.group === "week" ? "Week vanaf" : "Datum", ...meters.map((m) => `${m.name} (kWh)`), "Totaal (kWh)", "Tarief (EUR/kWh)", "Kost (EUR)", "Kwartierpiek (kW)", "Piek op"],
      ...list.map((g) => [p.group === "month" ? g.key : g.key.split("-").reverse().join("/"), ...meters.map((m) => csvNum(g.per[m.id])), csvNum(g.kwh),
        g.prices.size === 1 ? csvNum([...g.prices][0], 5) : "", csvNum(g.cost, 2), g.peak ? csvNum(g.peak.kw) : "", g.peak ? f.dateTime(g.peak.ts) : ""])]));
    barChart(body.querySelector("#cper"), {
      labels: list.map(short),
      series: meters.map((m, i) => ({ name: m.name, color: c[i % c.length], values: list.map((g) => g.per[m.id] || 0) })),
      tip: (i) => { const g = list[i]; return `<b>${esc(label(g))}</b><br>${kwh(g.kwh, p.group === "day" ? 2 : 1)}, ${eur(g.cost)}<br>${this._meterSplit(meters, g.per)}`; },
      onClick: p.group === "day" ? (i) => this._goDay(list[i].key) : null,
    });
  }

  /* ---------------- pieken ---------------- */
  async _peaksView(seq) {
    const res = await this._ws({ type: `${DOMAIN}/peaks` });
    if (seq !== this._seq) return;
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
function register() {
  const reg = window.customElements;
  if (!reg.get("btechnics-energie")) reg.define("btechnics-energie", class extends BtechnicsEnergieCard {});
  window.customCards = window.customCards || [];
  if (!window.customCards.find((c) => c.type === "btechnics-energie")) {
    window.customCards.push({ type: "btechnics-energie", name: "Btechnics Energie", description: "Verbruik, kost per dag, fasen en kwartierpieken" });
  }
}
register();
