// ============================================================
// PBMS ADMIN — MODUL GRAFIK TREN PENJUALAN (dipisah dari
// dashboard.js, pola Fix #81/#84). Helper mandiri berawalan
// `sales*` agar tidak memicu ReferenceError lintas modul.
// ============================================================

// Helper format rupiah — identik dengan dashboard.js
const salesFormatRupiah = (num) =>
  'Rp ' + (num || 0).toLocaleString('id-ID');

// Helper format angka — identik dengan dashboard.js
const salesFormatNumber = (num) =>
  (num || 0).toLocaleString('id-ID');

// ── GRAFIK TREN PENJUALAN (Fix #33) ──────────────────────────
// Grafik batang omzet harian via Canvas API (tanpa library).
// Cache display di localStorage agar refresh = instant (Fix #29/#32).
const SALES_CHART_CACHE_KEY = 'pbms_cached_sales_chart_data';
const salesBarChart    = document.getElementById('salesBarChart');
const chartCanvasWrap  = document.getElementById('chartCanvasWrap');
const chartTooltip     = document.getElementById('chartTooltip');
const chartTooltipDate = document.getElementById('chartTooltipDate');
const chartTooltipValue= document.getElementById('chartTooltipValue');
const chartTooltipCount= document.getElementById('chartTooltipCount');
const chartMaxOmzet    = document.getElementById('chartMaxOmzet');
const chartAvgOmzet    = document.getElementById('chartAvgOmzet');
const chartTotalOmzet  = document.getElementById('chartTotalOmzet');
const btnPeriodMonthly  = document.getElementById('btnPeriodMonthly');
const btnPeriod30Days   = document.getElementById('btnPeriod30Days');
let activeChartPeriod = 'monthly_daily';
let salesChartDataCache = null; // { labels, data, counts, summary, period }
// (Fix #40) Bar positions modul-scope agar handler mousemove baca
// nilai terbaru TANPA re-register listener tiap render.
let _salesBarPositions = [];
let _salesChartMeta    = { labels: [], data: [], counts: [], wrapW: 800, H: 300 };

const salesPersistCache = (payload) => {
  try { localStorage.setItem(SALES_CHART_CACHE_KEY, JSON.stringify(payload)); }
  catch (e) { /* private mode */ }
};
const salesLoadCache = () => {
  try {
    const raw = localStorage.getItem(SALES_CHART_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.labels)) return null;
    return parsed;
  } catch (e) { return null; }
};

// ── Render Grafik Canvas ─────────────────────────────────────
const renderSalesBarChart = (chart) => {
  if (!salesBarChart) return;
  const canvas = salesBarChart;
  const dpr = window.devicePixelRatio || 1;
  const wrapW = canvas.parentElement ? canvas.parentElement.clientWidth : 800;
  const H = 300;
  canvas.width  = wrapW * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = wrapW + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, wrapW, H);

  const labels = chart.labels || [];
  const data   = chart.data   || [];
  const n = labels.length;
  if (!n) return;

  const padL = 60, padR = 20, padT = 16, padB = 40;
  const chartW = wrapW - padL - padR;
  const chartH = H - padT - padB;
  const maxVal = Math.max(1, ...(chart.summary ? [chart.summary.max_omzet] : [0, ...data]));

  // Grid lines horizontal
  const gridLines = 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= gridLines; i++) {
    const y = padT + (chartH / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(wrapW - padR, y);
    ctx.stroke();
  }

  // Batang
  const gapRatio = 0.25;
  const barW = Math.max(4, (chartW / n) * (1 - gapRatio));
  const barGap = (chartW / n - barW);

  _salesBarPositions = [];
  _salesChartMeta = { labels, data, counts: chart.counts || [], wrapW, H, padL, padT, chartH, barGap, barW };

  for (let i = 0; i < n; i++) {
    const val = data[i] || 0;
    const x  = padL + barGap / 2 + i * (chartW / n);
    const barH = val > 0 ? Math.max(3, (val / maxVal) * chartH) : 0;
    const y = padT + chartH - barH;

    const grad = ctx.createLinearGradient(0, y, 0, padT + chartH);
    grad.addColorStop(0, 'rgba(0, 210, 255, 0.9)');
    grad.addColorStop(1, 'rgba(2, 132, 199, 0.5)');
    ctx.fillStyle = grad;

    const r = Math.min(4, barW / 2, barH);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.arcTo(x + barW, y, x + barW, y + r, r);
    ctx.lineTo(x + barW, padT + chartH);
    ctx.lineTo(x, padT + chartH);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
    ctx.fill();

    _salesBarPositions.push({ x, y, w: barW, h: barH, i });
  }

  // Label X (tanggal)
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelStep = Math.max(1, Math.ceil(n / Math.floor(chartW / 60)));
  for (let i = 0; i < n; i += labelStep) {
    const x = padL + i * (chartW / n) + (chartW / n) / 2;
    ctx.fillText(labels[i] || '', x, padT + chartH + 8);
  }

  // Label Y (omzet)
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= gridLines; i++) {
    const y = padT + (chartH / gridLines) * i;
    const val = maxVal - (maxVal / gridLines) * i;
    const label = val >= 1000000
      ? (val / 1000000).toFixed(1).replace(/\.0$/, '') + 'jt'
      : val >= 1000
        ? Math.round(val / 1000) + 'rb'
        : String(Math.round(val));
    ctx.fillStyle = '#64748b';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(label, padL - 8, y);
  }
};

// ── Tooltip via hover (Fix #40 — bind SATU KALI) ─────────────
(function bindSalesChartHover() {
  if (!salesBarChart) return;
  salesBarChart.addEventListener('mousemove', (e) => {
    if (!chartTooltip || !_salesBarPositions.length) return;
    const { labels, data, counts, wrapW, padT, chartH, barGap } = _salesChartMeta;
    const rect = salesBarChart.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let hit = null;
    for (const bp of _salesBarPositions) {
      if (mx >= bp.x && mx <= bp.x + bp.w + barGap) { hit = bp; break; }
    }
    if (hit) {
      if (chartTooltipDate)  chartTooltipDate.textContent  = labels[hit.i] || '';
      if (chartTooltipValue) chartTooltipValue.textContent = salesFormatRupiah(data[hit.i] || 0);
      if (chartTooltipCount) chartTooltipCount.textContent = ((counts || [])[hit.i] || 0) + ' transaksi';
      const tipW = 120;
      const tx = Math.max(0, Math.min(wrapW - tipW, hit.x + hit.w / 2 - tipW / 2));
      const ty = Math.max(0, (hit.h > 0 ? hit.y : padT + chartH) - 56);
      chartTooltip.style.left = tx + 'px';
      chartTooltip.style.top  = ty + 'px';
      chartTooltip.classList.add('is-visible');
    } else {
      chartTooltip.classList.remove('is-visible');
    }
  });
  salesBarChart.addEventListener('mouseleave', () => {
    if (chartTooltip) chartTooltip.classList.remove('is-visible');
  });
})();

const updateSalesChartSummary = (chart) => {
  const s = chart.summary || {};
  if (chartMaxOmzet)   chartMaxOmzet.textContent   = salesFormatRupiah(s.max_omzet);
  if (chartAvgOmzet)   chartAvgOmzet.textContent   = salesFormatRupiah(s.avg_omzet);
  if (chartTotalOmzet) chartTotalOmzet.textContent = salesFormatRupiah(s.total_omzet_period);
};

const loadSalesChart = async (period) => {
  activeChartPeriod = period;
  if (btnPeriodMonthly) btnPeriodMonthly.classList.toggle('is-active', period === 'monthly_daily');
  if (btnPeriod30Days)  btnPeriod30Days.classList.toggle('is-active',  period === 'last_30_days');
  try {
    const resp = await fetch('/api/admin/reports/sales-chart?period=' + encodeURIComponent(period));
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.message || 'Gagal memuat grafik');
    const chart = {
      labels:   data.labels   || [],
      data:     data.data     || [],
      counts:   data.counts   || [],
      summary:  data.summary  || {},
      period,
    };
    salesChartDataCache = chart;
    renderSalesBarChart(chart);
    updateSalesChartSummary(chart);
    salesPersistCache(chart);
  } catch (err) {
    console.warn('Gagal memuat grafik penjualan:', err.message);
  }
};

// Event listeners tombol periode
if (btnPeriodMonthly) btnPeriodMonthly.addEventListener('click', () => loadSalesChart('monthly_daily'));
if (btnPeriod30Days)  btnPeriod30Days.addEventListener('click',  () => loadSalesChart('last_30_days'));

// ── Re-render saat resize / tab aktif (koordinasi dengan HPP chart) ──
// HPP chart (dashboard.js) ikut di-re-render saat resize. Karena penjualan.js
// dimuat SEBELUM dashboard.js (defer berurutan), HPP chart belum ada di
// inisialisasi pertama; handler resize/bridge dipasang lewat window agar
// dashboard.js bisa mendaftar.
window.addEventListener('resize', () => {
  clearTimeout(window.__salesResizeTimer);
  window.__salesResizeTimer = setTimeout(() => {
    if (salesChartDataCache) renderSalesBarChart(salesChartDataCache);
    // Bridge: re-render HPP chart bila dashboard.js sudah mendaftarnya
    if (typeof window.__renderHppChartOnResize === 'function') window.__renderHppChartOnResize();
  }, 150);
});

// Bridge untuk dashboard.js (HPP chart) mendaftarkan re-render tab-active.
window.__salesReRenderChart = () => {
  requestAnimationFrame(() => {
    if (salesChartDataCache) renderSalesBarChart(salesChartDataCache);
    if (typeof window.__renderHppChartOnTabActivate === 'function') window.__renderHppChartOnTabActivate();
  });
};

// Init: cache instant → fetch refresh
(function initSalesChart() {
  const cached = salesLoadCache();
  if (cached && Array.isArray(cached.labels) && cached.labels.length) {
    salesChartDataCache = cached;
    renderSalesBarChart(cached);
    updateSalesChartSummary(cached);
    loadSalesChart(cached.period || activeChartPeriod);
  } else {
    loadSalesChart('monthly_daily');
  }
})();

// Eksport ke global (dipakai pemicu burger menu + dashboard.js bila perlu)
window.loadSalesChart = loadSalesChart;
