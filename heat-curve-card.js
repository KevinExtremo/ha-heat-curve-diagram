// Heat Curve Card — drag-editable multi-line schedule chart for Home Assistant.
//
// Renders an arbitrary number of lines (each backed by a series of `input_number` entities,
// one per hour) on a single SVG chart. Any point can be dragged up/down to change that hour's
// value. Two lines can be declared as a min/max pair with a minimum required gap, enforced live
// while dragging so they can never cross or touch.
//
// Config:
//   type: custom:heat-curve-card
//   title: Hobby Room — Heat Curve
//   hours: [8, 9, 10, ... 21]        # which hours to plot, in order
//   y_range: [16, 26]                # fixed y-axis range
//   step: 0.5                        # value snap step (should match the input_number's own step)
//   height: 260                      # optional, defaults to 260
//   tabs:                            # optional — splits `lines` into switchable groups so only
//                                     # a couple of lines (and their points) are visible/draggable
//                                     # at once, instead of all of them crowded together
//     - label: Heat
//       lines: [heat_min, heat_max]
//     - label: Cool
//       lines: [cool_min, cool_max]
//   lines:
//     - id: heat_min
//       entity_prefix: input_number.hobby_room_heat_min_   # + zero-padded hour -> entity_id
//       color: "#2980b9"
//       label: Heat Min
//       role: min                    # 'min' or 'max' — only needed if `pair` is set
//       pair: heat_max               # id of the paired line, optional
//       min_gap: 0.5                 # minimum allowed distance from the paired line
//     - id: heat_max
//       entity_prefix: input_number.hobby_room_heat_max_
//       color: "#e74c3c"
//       label: Heat Max
//       role: max
//       pair: heat_min
//       min_gap: 0.5

const NS = "http://www.w3.org/2000/svg";
const SEND_THROTTLE_MS = 150;
const POINT_RADIUS = 8;

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

class HeatCurveCard extends HTMLElement {
  setConfig(config) {
    if (!config.hours || !config.hours.length) throw new Error("heat-curve-card: `hours` is required");
    if (!config.lines || !config.lines.length) throw new Error("heat-curve-card: `lines` is required");
    this._config = {
      y_range: [16, 26],
      step: 0.5,
      width: 500,
      height: 420,
      ...config,
    };
    this._dragging = null; // { lineId, hour, entityId, pointerId }
    this._localValues = {}; // entity_id -> value while drag hasn't been confirmed by hass yet
    this._lastSent = {}; // entity_id -> { value, ts }
    this._activeTab = 0;
    this._built = false;
    this._buildDom();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) return;
    this._syncFromHass();
  }

  getCardSize() {
    return 3;
  }

  // ---- layout helpers ----

  _padding() {
    return { top: 16, right: 16, bottom: 28, left: 40 };
  }

  _plotRect() {
    const { width, height } = this._config;
    const p = this._padding();
    return { x: p.left, y: p.top, w: width - p.left - p.right, h: height - p.top - p.bottom };
  }

  _xScale(hour) {
    const hours = this._config.hours;
    const r = this._plotRect();
    const span = hours[hours.length - 1] - hours[0] || 1;
    return r.x + ((hour - hours[0]) / span) * r.w;
  }

  _yScale(value) {
    const [ymin, ymax] = this._config.y_range;
    const r = this._plotRect();
    const clamped = Math.max(ymin, Math.min(ymax, value));
    return r.y + (1 - (clamped - ymin) / (ymax - ymin)) * r.h;
  }

  _yInverse(pixelY) {
    const [ymin, ymax] = this._config.y_range;
    const r = this._plotRect();
    const frac = 1 - (pixelY - r.y) / r.h;
    return ymin + frac * (ymax - ymin);
  }

  _entityId(line, hour) {
    return `${line.entity_prefix}${String(hour).padStart(2, "0")}`;
  }

  // ---- DOM construction (once) ----

  _buildDom() {
    const { width, height, title } = this._config;
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; }
      ha-card { padding: 12px 8px 8px; }
      .title { font-size: 1.1em; font-weight: 500; padding: 0 8px 8px; }
      .tabs { display: flex; gap: 4px; padding: 0 8px 8px; }
      .tabs button {
        flex: 1; border: none; border-radius: 8px; padding: 6px 10px; font-size: 0.9em;
        background: var(--secondary-background-color, #eee); color: var(--primary-text-color, #333);
        cursor: pointer;
      }
      .tabs button.active {
        background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff);
      }
      /* pan-y (not none): lets a touch that starts on empty chart background still scroll the
         page vertically. A touch that starts on a point (.pt) calls preventDefault() on its own
         pointerdown, which overrides this and suppresses the scroll for that gesture -- so
         dragging a point still works, it's only the rest of the chart that stays scrollable. */
      svg { display: block; width: 100%; height: auto; touch-action: pan-y; }
      .grid line { stroke: var(--divider-color, #e0e0e0); stroke-width: 1; }
      .grid line.major { stroke: var(--secondary-text-color, #bbb); }
      .axis text { fill: var(--secondary-text-color, #888); font-size: 9px; }
      .axis text.major { font-size: 10px; font-weight: 600; }
      .pt { cursor: grab; }
      .pt:active { cursor: grabbing; }
      .legend text { fill: var(--primary-text-color, #333); font-size: 11px; }
      .drag-tooltip text { fill: #fff; font-size: 12px; font-weight: 600; }
    `;
    shadow.appendChild(style);

    const card = document.createElement("ha-card");
    if (title) {
      const t = document.createElement("div");
      t.className = "title";
      t.textContent = title;
      card.appendChild(t);
    }

    if (this._config.tabs && this._config.tabs.length) {
      this._buildTabs(card);
    }

    const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}` });
    this._svg = svg;
    card.appendChild(svg);
    shadow.appendChild(card);

    this._drawStatic(svg);
    this._drawLines(svg);
    this._buildDragTooltip(svg);
    this._applyTabVisibility();

    svg.addEventListener("pointermove", (e) => this._onPointerMove(e));
    svg.addEventListener("pointerup", (e) => this._onPointerUp(e));
    svg.addEventListener("pointercancel", (e) => this._onPointerUp(e));

    this._built = true;
  }

  _drawStatic(svg) {
    const r = this._plotRect();
    const [ymin, ymax] = this._config.y_range;
    const hours = this._config.hours;

    // gridlines/labels at every `step` (0.5 by default) — matches the actual editing
    // granularity, so a dragged point always lines up visually with a labeled line. Whole
    // degrees get a slightly bolder line + label to stay readable among the half-degree ones.
    const gridStep = this._config.step;
    const stepCount = Math.round((ymax - ymin) / gridStep);

    const grid = svgEl("g", { class: "grid" });
    for (let i = 0; i <= stepCount; i++) {
      const v = Math.round((ymin + i * gridStep) * 100) / 100;
      const y = this._yScale(v);
      const major = Number.isInteger(v);
      grid.appendChild(svgEl("line", { x1: r.x, x2: r.x + r.w, y1: y, y2: y, class: major ? "major" : "" }));
    }
    svg.appendChild(grid);

    const axis = svgEl("g", { class: "axis" });
    for (let i = 0; i <= stepCount; i++) {
      const v = Math.round((ymin + i * gridStep) * 100) / 100;
      const y = this._yScale(v);
      const major = Number.isInteger(v);
      const t = svgEl("text", { x: r.x - 6, y: y + 3, "text-anchor": "end", class: major ? "major" : "" });
      t.textContent = major ? v : v.toFixed(1);
      axis.appendChild(t);
    }
    hours.forEach((h) => {
      const x = this._xScale(h);
      const t = svgEl("text", { x, y: r.y + r.h + 16, "text-anchor": "middle" });
      t.textContent = h;
      axis.appendChild(t);
    });
    svg.appendChild(axis);

    this._legendEls = {};
    const legend = svgEl("g", { class: "legend" });
    this._config.lines.forEach((line) => {
      const g = svgEl("g", {});
      g.appendChild(svgEl("circle", { cx: r.x + r.w + 6, r: 3, fill: line.color }));
      const t = svgEl("text", { x: r.x + r.w + 12 });
      t.textContent = line.label || line.id;
      g.appendChild(t);
      legend.appendChild(g);
      this._legendEls[line.id] = g;
    });
    // legend sits outside the main plot width, so widen the viewBox to fit it
    svg.setAttribute("viewBox", `0 0 ${this._config.width + 60} ${this._config.height}`);
    svg.appendChild(legend);
  }

  _drawLines(svg) {
    this._lineGroups = {};
    this._pathEls = {};
    this._pointEls = {};
    this._config.lines.forEach((line) => {
      const g = svgEl("g", { "data-line-id": line.id });
      svg.appendChild(g);
      this._lineGroups[line.id] = g;

      const path = svgEl("polyline", { fill: "none", stroke: line.color, "stroke-width": 2 });
      g.appendChild(path);
      this._pathEls[line.id] = path;
      this._pointEls[line.id] = {};
      this._config.hours.forEach((hour) => {
        const entityId = this._entityId(line, hour);
        const c = svgEl("circle", { r: POINT_RADIUS, fill: line.color, class: "pt" });
        c.dataset.lineId = line.id;
        c.dataset.hour = hour;
        c.dataset.entityId = entityId;
        c.addEventListener("pointerdown", (e) => this._onPointerDown(e, line, hour, entityId));
        g.appendChild(c);
        this._pointEls[line.id][hour] = c;
      });
    });
  }

  // ---- drag value tooltip ----

  _buildDragTooltip(svg) {
    const g = svgEl("g", { class: "drag-tooltip" });
    g.style.display = "none";
    const rect = svgEl("rect", { rx: 4, ry: 4, width: 42, height: 20, fill: "var(--primary-color, #03a9f4)" });
    const text = svgEl("text", { x: 21, "text-anchor": "middle", y: 14 });
    g.appendChild(rect);
    g.appendChild(text);
    svg.appendChild(g);
    this._dragTooltip = { g, rect, text };
  }

  _showDragTooltip(hour, value) {
    const tt = this._dragTooltip;
    const px = this._xScale(hour);
    const py = this._yScale(value);
    tt.rect.setAttribute("x", px - 21);
    tt.rect.setAttribute("y", py - 34);
    tt.text.setAttribute("x", px);
    tt.text.setAttribute("y", py - 20);
    tt.text.textContent = `${value.toFixed(1)}°`;
    tt.g.style.display = "";
  }

  _hideDragTooltip() {
    this._dragTooltip.g.style.display = "none";
  }

  // ---- tabs ----

  _buildTabs(card) {
    const wrap = document.createElement("div");
    wrap.className = "tabs";
    this._config.tabs.forEach((tab, i) => {
      const btn = document.createElement("button");
      btn.textContent = tab.label;
      if (i === this._activeTab) btn.classList.add("active");
      btn.addEventListener("click", () => {
        this._activeTab = i;
        wrap.querySelectorAll("button").forEach((b, bi) => b.classList.toggle("active", bi === i));
        this._applyTabVisibility();
      });
      wrap.appendChild(btn);
    });
    card.appendChild(wrap);
  }

  _visibleLineIds() {
    const tabs = this._config.tabs;
    if (!tabs || !tabs.length) return this._config.lines.map((l) => l.id);
    return tabs[this._activeTab].lines;
  }

  _applyTabVisibility() {
    const visible = new Set(this._visibleLineIds());
    let legendIndex = 0;
    const r = this._plotRect();
    this._config.lines.forEach((line) => {
      const shown = visible.has(line.id);
      this._lineGroups[line.id].style.display = shown ? "" : "none";
      const legendEl = this._legendEls[line.id];
      legendEl.style.display = shown ? "" : "none";
      if (shown) {
        const ly = r.y + legendIndex * 14;
        legendEl.querySelector("circle").setAttribute("cy", ly);
        legendEl.querySelector("text").setAttribute("y", ly + 3);
        legendIndex += 1;
      }
    });
  }

  // ---- reactive updates from hass ----

  _valueFor(line, hour) {
    const entityId = this._entityId(line, hour);
    if (this._dragging && this._dragging.entityId === entityId) {
      return this._localValues[entityId];
    }
    if (entityId in this._localValues) return this._localValues[entityId];
    const st = this._hass && this._hass.states[entityId];
    return st ? parseFloat(st.state) : null;
  }

  _syncFromHass() {
    this._config.lines.forEach((line) => {
      const pts = [];
      this._config.hours.forEach((hour) => {
        const v = this._valueFor(line, hour);
        if (v === null || Number.isNaN(v)) return;
        const x = this._xScale(hour);
        const y = this._yScale(v);
        pts.push(`${x},${y}`);
        const c = this._pointEls[line.id][hour];
        c.setAttribute("cx", x);
        c.setAttribute("cy", y);
      });
      this._pathEls[line.id].setAttribute("points", pts.join(" "));
    });
  }

  // ---- drag handling ----

  _onPointerDown(e, line, hour, entityId) {
    e.preventDefault();
    e.target.setPointerCapture(e.pointerId);
    const st = this._hass.states[entityId];
    this._dragging = {
      pointerId: e.pointerId,
      line,
      hour,
      entityId,
      entMin: st && st.attributes.min !== undefined ? st.attributes.min : this._config.y_range[0],
      entMax: st && st.attributes.max !== undefined ? st.attributes.max : this._config.y_range[1],
    };
    this._localValues[entityId] = parseFloat(st.state);
    this._showDragTooltip(hour, this._localValues[entityId]);
  }

  _pairedValue(line, hour) {
    if (!line.pair) return null;
    const pairLine = this._config.lines.find((l) => l.id === line.pair);
    if (!pairLine) return null;
    return this._valueFor(pairLine, hour);
  }

  _onPointerMove(e) {
    const d = this._dragging;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();

    const rect = this._svg.getBoundingClientRect();
    const scaleY = this._config.height / rect.height;
    const svgY = (e.clientY - rect.top) * scaleY;
    let value = this._yInverse(svgY);

    const step = this._config.step;
    value = Math.round(value / step) * step;
    value = Math.max(d.entMin, Math.min(d.entMax, value));

    const pairVal = this._pairedValue(d.line, d.hour);
    const minGap = d.line.min_gap || 0;
    if (pairVal !== null && minGap > 0) {
      if (d.line.role === "min" && value > pairVal - minGap) value = pairVal - minGap;
      if (d.line.role === "max" && value < pairVal + minGap) value = pairVal + minGap;
    }

    this._localValues[d.entityId] = value;
    this._syncFromHass();
    this._showDragTooltip(d.hour, value);
    this._maybeSend(d.entityId, value);
  }

  _onPointerUp(e) {
    const d = this._dragging;
    if (!d || e.pointerId !== d.pointerId) return;
    const value = this._localValues[d.entityId];
    this._sendNow(d.entityId, value);
    this._hideDragTooltip();
    this._dragging = null;
    // keep the local value pinned until hass state actually reflects it, to avoid a visual
    // snap-back while waiting for the round trip
    const check = () => {
      const st = this._hass.states[d.entityId];
      if (st && parseFloat(st.state) === value) {
        delete this._localValues[d.entityId];
        this._syncFromHass();
      } else {
        setTimeout(check, 200);
      }
    };
    setTimeout(check, 200);
  }

  _maybeSend(entityId, value) {
    const last = this._lastSent[entityId];
    const now = Date.now();
    if (last && last.value === value) return;
    if (last && now - last.ts < SEND_THROTTLE_MS) return;
    this._sendNow(entityId, value);
  }

  _sendNow(entityId, value) {
    this._lastSent[entityId] = { value, ts: Date.now() };
    this._hass.callService("input_number", "set_value", { entity_id: entityId, value });
  }
}

customElements.define("heat-curve-card", HeatCurveCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "heat-curve-card",
  name: "Heat Curve Card",
  description: "Drag-editable multi-line hourly schedule chart with min/max gap enforcement.",
});
