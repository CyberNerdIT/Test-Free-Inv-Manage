// Tiny dependency-free canvas charting: a line chart (with an optional second
// "projected" series) and a horizontal bar chart. Handles high-DPI displays.

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.clientWidth || 600;
  const height = rect.height || canvas.clientHeight || 300;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function css(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function niceCeil(v) {
  if (v <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

const fmtMoney = (n) =>
  (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

/**
 * drawLineChart(canvas, { labels, series: [{name,color,points:[{x,y}]}], ... })
 * Points use numeric x (e.g. timestamp) and y. If labels provided they map to x ticks.
 */
export function drawLineChart(canvas, cfg) {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);

  const padL = 60, padR = 16, padT = 16, padB = 42;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const series = cfg.series.filter((s) => s.points && s.points.length);
  const gridColor = css('--grid', '#e5e7eb');
  const axisColor = css('--muted', '#6b7280');
  const textColor = css('--text', '#111827');

  if (!series.length) {
    ctx.fillStyle = axisColor;
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data yet — sell an item or set a listing price.', width / 2, height / 2);
    return;
  }

  const allX = series.flatMap((s) => s.points.map((p) => p.x));
  const allY = series.flatMap((s) => s.points.map((p) => p.y));
  let minX = Math.min(...allX), maxX = Math.max(...allX);
  if (minX === maxX) { minX -= 1; maxX += 1; }
  let minY = Math.min(0, ...allY);
  let maxY = Math.max(...allY, 0);
  const span = maxY - minY || 1;
  maxY = maxY + span * 0.1;
  const yTop = niceCeil(maxY);
  const yBottom = minY < 0 ? -niceCeil(-minY) : 0;

  const xToPx = (x) => padL + ((x - minX) / (maxX - minX)) * plotW;
  const yToPx = (y) => padT + (1 - (y - yBottom) / (yTop - yBottom)) * plotH;

  // Y grid + labels
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const val = yBottom + ((yTop - yBottom) * i) / ticks;
    const py = yToPx(val);
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(width - padR, py);
    ctx.stroke();
    ctx.fillStyle = axisColor;
    ctx.fillText(fmtMoney(val), padL - 8, py);
  }

  // Zero line emphasis
  const zeroPy = yToPx(0);
  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padL, zeroPy);
  ctx.lineTo(width - padR, zeroPy);
  ctx.stroke();

  // X labels (dates)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelPoints = cfg.xLabels || [];
  const maxLabels = Math.min(labelPoints.length, 6);
  if (labelPoints.length) {
    const stepIdx = Math.max(1, Math.ceil(labelPoints.length / maxLabels));
    labelPoints.forEach((lp, i) => {
      if (i % stepIdx !== 0 && i !== labelPoints.length - 1) return;
      const px = xToPx(lp.x);
      ctx.fillStyle = axisColor;
      ctx.fillText(lp.label, px, height - padB + 8);
    });
  }

  // Series
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.dashed ? 2 : 2.5;
    if (s.dashed) ctx.setLineDash([6, 5]);
    else ctx.setLineDash([]);
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const px = xToPx(p.x), py = yToPx(p.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    // dots
    ctx.fillStyle = s.color;
    for (const p of s.points) {
      ctx.beginPath();
      ctx.arc(xToPx(p.x), yToPx(p.y), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Legend
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let lx = padL + 4;
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, padT + 2, 14, 4);
    ctx.fillStyle = textColor;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(s.name, lx + 20, padT + 4);
    lx += 28 + ctx.measureText(s.name).width + 24;
  }
}

/**
 * drawBarChart(canvas, { bars: [{label, value, color}] })  horizontal bars.
 */
export function drawBarChart(canvas, cfg) {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const bars = cfg.bars || [];
  if (!bars.length) return;

  const padL = 130, padR = 60, padT = 8, padB = 8;
  const plotW = width - padL - padR;
  const rowH = (height - padT - padB) / bars.length;
  const maxV = Math.max(...bars.map((b) => Math.abs(b.value)), 1);
  const scale = niceCeil(maxV);
  const textColor = css('--text', '#111827');
  const axisColor = css('--muted', '#6b7280');

  ctx.font = '12px system-ui, sans-serif';
  bars.forEach((b, i) => {
    const y = padT + i * rowH + rowH * 0.2;
    const h = rowH * 0.6;
    const w = (Math.abs(b.value) / scale) * plotW;
    ctx.fillStyle = b.color || (b.value >= 0 ? css('--pos', '#16a34a') : css('--neg', '#dc2626'));
    ctx.fillRect(padL, y, Math.max(w, 1), h);
    ctx.fillStyle = textColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label.slice(0, 22), padL - 8, y + h / 2);
    ctx.textAlign = 'left';
    ctx.fillStyle = axisColor;
    ctx.fillText(fmtMoney(b.value), padL + w + 6, y + h / 2);
  });
}

/**
 * drawColumnChart(canvas, { columns: [{label, value}], line: [{label, value}], lineName })
 *
 * Vertical bars for what each period earned, with an optional cumulative line
 * over the top. This is the shape a profit history needs: the bars answer
 * "what did March make", the line answers "where are we overall". A single
 * cumulative line alone cannot show a bad month — it just flattens.
 */
export function drawColumnChart(canvas, cfg) {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const cols = cfg.columns || [];
  const gridColor = css('--grid', '#e5e7eb');
  const axisColor = css('--muted', '#6b7280');
  const textColor = css('--text', '#111827');

  if (!cols.length) {
    ctx.fillStyle = axisColor;
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(cfg.empty || 'No sales in this period.', width / 2, height / 2);
    return;
  }

  const padL = 62, padR = cfg.line ? 62 : 16, padT = 18, padB = 46;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  // Bars and the cumulative line have very different magnitudes, so they get
  // their own scales (and their own labelled axis) rather than one squashing
  // the other flat.
  const vals = cols.map((c) => c.value);
  const barMax = niceCeil(Math.max(...vals.map(Math.abs), 1));
  const hasNeg = vals.some((v) => v < 0);
  const barMin = hasNeg ? -barMax : 0;
  const yBar = (v) => padT + plotH - ((v - barMin) / (barMax - barMin)) * plotH;

  ctx.font = '11px system-ui, sans-serif';
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  const TICKS = 4;
  for (let i = 0; i <= TICKS; i++) {
    const v = barMin + ((barMax - barMin) * i) / TICKS;
    const y = Math.round(yBar(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    ctx.fillStyle = axisColor;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(fmtMoney(v), padL - 8, y);
  }

  const slot = plotW / cols.length;
  const barW = Math.max(2, Math.min(slot * 0.68, 46));
  const zeroY = yBar(0);

  cols.forEach((c, i) => {
    const cx = padL + slot * i + slot / 2;
    const y = yBar(c.value);
    const h = Math.abs(y - zeroY);
    ctx.fillStyle = c.color || (c.value >= 0 ? css('--pos', '#16a34a') : css('--neg', '#dc2626'));
    if (c.value === 0) {
      // A zero period still gets a hairline, so an empty month is visibly
      // "nothing sold" rather than a hole in the axis.
      ctx.globalAlpha = 0.28;
      ctx.fillRect(cx - barW / 2, zeroY - 1, barW, 1.5);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillRect(cx - barW / 2, Math.min(y, zeroY), barW, Math.max(h, 1));
    }
  });

  // X labels — thinned so they never overlap.
  const every = Math.ceil((cols.length * 46) / plotW);
  ctx.fillStyle = axisColor;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  cols.forEach((c, i) => {
    if (i % every) return;
    ctx.fillText(c.label, padL + slot * i + slot / 2, padT + plotH + 8);
  });

  // Cumulative line on its own right-hand axis.
  if (cfg.line && cfg.line.length) {
    const lv = cfg.line.map((p) => p.value);
    const lMax = niceCeil(Math.max(...lv.map(Math.abs), 1));
    const lMin = lv.some((v) => v < 0) ? -lMax : 0;
    const yLine = (v) => padT + plotH - ((v - lMin) / (lMax - lMin)) * plotH;

    ctx.strokeStyle = cfg.lineColor || css('--accent', '#7c3aed');
    ctx.lineWidth = 2;
    ctx.beginPath();
    cfg.line.forEach((p, i) => {
      const x = padL + slot * i + slot / 2;
      const y = yLine(p.value);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = axisColor;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= TICKS; i++) {
      const v = lMin + ((lMax - lMin) * i) / TICKS;
      ctx.fillText(fmtMoney(v), padL + plotW + 8, yLine(v));
    }
  }

  // Legend
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  let lx = padL;
  const chip = (color, label) => {
    ctx.fillStyle = color; ctx.fillRect(lx, padT - 12, 10, 10);
    ctx.fillStyle = textColor; ctx.fillText(label, lx + 14, padT - 7);
    lx += 22 + ctx.measureText(label).width;
  };
  chip(css('--pos', '#16a34a'), cfg.barName || 'Profit per period');
  if (cfg.line && cfg.line.length) chip(cfg.lineColor || css('--accent', '#7c3aed'), cfg.lineName || 'Cumulative');
}

export { fmtMoney };
