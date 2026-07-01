//  CHARTS
// ═══════════════════════════════════════════════════════════════════════
const ZOOM_CFG = {
  zoom: { wheel:{enabled:true}, pinch:{enabled:true}, mode:'xy' },
  pan:  { enabled:true, mode:'xy' },
};

// Config QUAD : axe X numérique fixe (masse), datasets = {x, y}
function makeQuadOpts(log, startMass, endMass) {
  return {
    responsive:true, maintainAspectRatio:false, animation:false,
    plugins: {
      legend: { display: true, labels: { color:'#4e5a6b', font:{family:'Consolas',size:10}, boxWidth:20 } },
      zoom: ZOOM_CFG,
      tooltip: {
        mode:'nearest', intersect:false,
        backgroundColor:'#ffffff', borderColor:'#d0d5dd', borderWidth:1,
        titleColor:'#6b7280', bodyColor:'#111827',
        bodyFont:{family:'Consolas'}, titleFont:{family:'Consolas'},
        callbacks: {
          title: items => `m/z = ${items[0]?.parsed?.x?.toFixed(2) ?? ''}`,
          label: item => ` ${item.dataset.label}: ${item.parsed.y?.toExponential(3)}`,
        }
      }
    },
    scales: {
      x: {
        type: 'linear',
        min: startMass - 1, max: endMass + 1,
        ticks: { color:'#6b7280', stepSize: 2, font:{family:'Consolas',size:12} },
        grid: { color:'rgba(0,0,0,.06)' }, border:{ color:'#d0d5dd' },
        title: { display:true, text:'Masse (m/z)', color:'#6b7280', font:{family:'Consolas',size:12} }
      },
      y: {
        type: log ? 'logarithmic' : 'linear',
        ticks: {
          color:'#6b7280', font:{family:'Consolas',size:12},
          callback: v => {
            if (v === 0) return '0';
            if (log) {
              const e = Math.log10(v);
              return Number.isInteger(Math.round(e*10)/10) ? v.toExponential(0) : '';
            }
            return v.toExponential(0);
          }
        },
        grid: { color:'rgba(0,0,0,.06)' }, border:{ color:'#d0d5dd' },
        title: { display:true, text: log ? 'Signal (A) — log' : 'Signal (A)', color:'#6b7280', font:{family:'Consolas',size:12} }
      }
    }
  };
}

function makeQuadChart(id, log) {
  return new Chart(document.getElementById(id), {
    type: 'line',
    data: { datasets: [
      { label:'Cycle en cours', data:[], borderColor:'#22d3ee', borderWidth:1.5,
        pointRadius:0, fill:false, tension:0 },
      { label:'Cycle précédent', data:[], borderColor:'#e8531a', borderWidth:1,
        pointRadius:0, fill:false, tension:0, borderDash:[4,3], opacity:0.6 },
    ]},
    options: makeQuadOpts(log, 3, 70),
  });
}

// Config jauge / historique : labels string, axe Y log
function makeOpts(log) {
  return {
    responsive:true, maintainAspectRatio:false, animation:false,
    plugins: {
      legend: { display:false },
      zoom: ZOOM_CFG,
      tooltip: {
        mode:'index', intersect:false,
        backgroundColor:'#111419', borderColor:'#1e2530', borderWidth:1,
        titleColor:'#4e5a6b', bodyColor:'#d4dae4',
        bodyFont:{family:'Consolas'}, titleFont:{family:'Consolas'},
      }
    },
    scales: {
      x: {
        ticks:{ color:'#6b7280', maxTicksLimit:12, font:{family:'Consolas',size:12} },
        grid:{ color:'rgba(0,0,0,.06)' }, border:{ color:'#d0d5dd' }
      },
      y: {
        type: log ? 'logarithmic' : 'linear',
        ticks: {
          color:'#6b7280', font:{family:'Consolas',size:12},
          ...(log ? { callback: v => {
            const e = Math.log10(v);
            return Number.isInteger(Math.round(e*10)/10) ? v.toExponential(0) : '';
          }} : {})
        },
        grid:{ color:'rgba(0,0,0,.06)' }, border:{ color:'#d0d5dd' }
      }
    }
  };
}
function makeChart(id, log, colors) {
  return new Chart(document.getElementById(id), {
    type:'line',
    data:{ labels:[], datasets: colors.map((c,i) => ({
      data:[], borderColor:c, borderWidth:1.5, pointRadius:0,
      fill:false, tension:0.1,
      borderDash: i === 1 ? [4,3] : [],
    }))},
    options: makeOpts(log),
  });
}
function resetZoom(c) { c.resetZoom(); }

// QUAD charts — initialisés après DOMContentLoaded via initQuadCharts()
let chartLin, chartLog, chartHistLin, chartHistLog;

function initQuadCharts() {
  chartLin     = makeQuadChart('chart-lin',      false);
  chartLog     = makeQuadChart('chart-log',      true);
  chartHistLin = makeChart('chart-hist-lin', false, ['#f59e0b']);
  chartHistLog = makeChart('chart-hist-log', true,  ['#f59e0b']);
}

// Jauge — Canvas 2D direct (pas Chart.js, pas de freeze sur grandes fenêtres)
const J_BG      = '#ffffff';
const J_GRID    = 'rgba(0,0,0,0.07)';
const J_COLORS  = { j1: '#c0390f', j2: '#0284c7' };

// Throttle jauge : max 2 renders/sec
const _jDirty = { j1: false, j2: false };
function scheduleJaugeDraw(id) { _jDirty[id] = true; }

// État hover tooltip par canal
const jHover = { j1: null, j2: null };

// État zoom/pan par canal
const jZoom = {
  j1: { lo: null, hi: null, dragging: false, dragStartX: 0, dragStartLo: 0, dragStartHi: 0 },
  j2: { lo: null, hi: null, dragging: false, dragStartX: 0, dragStartLo: 0, dragStartHi: 0 },
};

function resetJaugeZoom(id) {
  jZoom[id].lo = null; jZoom[id].hi = null;
  _jDirty[id] = true;
}

function initJaugeInteraction(id) {
  const cvs = document.getElementById('canvas-'+id);
  if (!cvs || cvs._jaugeInit) return;
  cvs._jaugeInit = true;

  // Molette — zoom centré sur le curseur
  cvs.addEventListener('wheel', (e) => {
    e.preventDefault();
    const data = jState[id].data;
    if (!data.length) return;
    const z    = jZoom[id];
    const lo   = z.lo ?? getWindowBounds(id).lo;
    const hi   = z.hi ?? getWindowBounds(id).hi;
    const count = hi - lo + 1;
    const rect  = cvs.getBoundingClientRect();
    const PAD_L = 72;
    const frac  = Math.max(0, Math.min(1, (e.clientX - rect.left - PAD_L) / (rect.width - PAD_L - 8)));
    const center = lo + frac * (count - 1);
    const factor = e.deltaY > 0 ? 1.25 : 0.8; // zoom out / in
    const newHalf = (count / 2) * factor;
    z.lo = Math.max(0, Math.round(center - newHalf));
    z.hi = Math.min(data.length - 1, Math.round(center + newHalf));
    if (z.hi - z.lo < 2) { z.lo = Math.max(0, z.hi - 2); }
    _jDirty[id] = true;
  }, { passive: false });

  // Clic + glisser — pan
  cvs.addEventListener('mousedown', (e) => {
    const z = jZoom[id];
    z.dragging    = true;
    z.dragStartX  = e.clientX;
    z.dragStartLo = z.lo ?? getWindowBounds(id).lo;
    z.dragStartHi = z.hi ?? getWindowBounds(id).hi;
    cvs.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    const z = jZoom[id];
    if (!z.dragging) return;
    const data  = jState[id].data;
    if (!data.length) return;
    const rect  = cvs.getBoundingClientRect();
    const pw    = rect.width - 72 - 8;
    const count = z.dragStartHi - z.dragStartLo + 1;
    const dx    = e.clientX - z.dragStartX;
    const shift = Math.round(dx / pw * count);
    let lo = z.dragStartLo - shift;
    let hi = z.dragStartHi - shift;
    if (lo < 0)                    { hi -= lo; lo = 0; }
    if (hi > data.length - 1)      { lo -= (hi - data.length + 1); hi = data.length - 1; }
    z.lo = Math.max(0, lo); z.hi = Math.min(data.length - 1, hi);
    _jDirty[id] = true;
  });
  window.addEventListener('mouseup', () => {
    if (jZoom[id].dragging) {
      jZoom[id].dragging = false;
      cvs.style.cursor = 'crosshair';
    }
  });

  // Double-clic — reset zoom
  cvs.addEventListener('dblclick', () => resetJaugeZoom(id));

  // Survol → tooltip
  cvs.addEventListener('mousemove', (e) => {
    if (jZoom[id].dragging) return;
    const data = jState[id].data;
    if (!data.length) { jHover[id] = null; return; }
    const rect = cvs.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const PAD_L = 110;
    if (mx < PAD_L || mx > rect.width - 8) { jHover[id] = null; _jDirty[id] = true; return; }
    const z  = jZoom[id];
    const lo = z.lo ?? getWindowBounds(id).lo;
    const hi = z.hi ?? getWindowBounds(id).hi;
    const count = hi - lo + 1;
    const pw  = rect.width - PAD_L - 8;
    const frac = (mx - PAD_L) / pw;
    const idx  = Math.max(lo, Math.min(hi, Math.round(lo + frac * (count - 1))));
    jHover[id] = { idx };
    _jDirty[id] = true;
  });
  cvs.addEventListener('mouseleave', () => {
    jHover[id] = null;
    _jDirty[id] = true;
  });
}

function getWindowBounds(id) {
  const st   = jState[id];
  const data = st.data;
  if (!data.length) return { lo: 0, hi: 0 };
  const n = data.length - 1;

  // Si les thumbs ont été bougés (pas full range), utiliser leurs positions
  const s = dSlider[id];
  if (s.lo > 0 || s.hi < 100) {
    return {
      lo: Math.floor(s.lo / 100 * n),
      hi: Math.min(n, Math.round(s.hi / 100 * n)),
    };
  }

  // Sinon, fenêtre temporelle classique
  let lo = 0, hi = n;
  if (st.winMin > 0) {
    const durMs = st.winMin * 60 * 1000;
    const endTs = data[hi].ts;
    const from  = endTs - durMs;
    let a = 0, b = hi;
    while (a < b) { const mid=(a+b)>>1; data[mid].ts < from ? a=mid+1 : b=mid; }
    lo = a;
  }
  return { lo, hi };
}

function drawJaugeCanvas(id) {
  const st   = jState[id];
  const data = st.data;
  const cvs  = document.getElementById('canvas-'+id);
  if (!cvs) return;

  // Init interactions une seule fois
  initJaugeInteraction(id);

  const dpr = window.devicePixelRatio || 1;
  const W   = cvs.clientWidth;
  const H   = cvs.clientHeight;
  if (cvs.width !== W*dpr || cvs.height !== H*dpr) {
    cvs.width  = W * dpr;
    cvs.height = H * dpr;
  }
  const ctx = cvs.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = J_BG;
  ctx.fillRect(0, 0, W, H);
  if (!data.length) return;

  // Bornes : zoom manuel ou fenêtre temporelle
  const z    = jZoom[id];
  const wb   = getWindowBounds(id);
  const lo   = z.lo !== null ? z.lo : wb.lo;
  const hi   = z.hi !== null ? z.hi : wb.hi;
  const count = hi - lo + 1;
  if (count < 2) return;
  let yMin = Infinity, yMax = -Infinity;
  const DISP = Math.min(count, 1200);
  const step = Math.ceil(count / DISP);
  for (let i = lo; i <= hi; i += step) {
    const v = data[i].value;
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  }
  const range  = yMax - yMin || yMax * 0.1 || 1e-12;
  yMin = Math.max(0, yMin - range * 0.1); // plancher à 0, marge 10% en bas
  yMax = yMax + range * 0.1;              // marge 10% en haut
  const yRange = yMax - yMin || 1e-10;

  const PAD = { t:8, b:28, l:110, r:8 };
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;

  // Grille Y
  ctx.strokeStyle = J_GRID;
  ctx.lineWidth   = 0.5;
  ctx.fillStyle   = 'rgba(0,0,0,0.45)';
  ctx.font        = `12px Consolas,monospace`;
  ctx.textAlign   = 'right';
  const YTICKS = 5;
  for (let t = 0; t <= YTICKS; t++) {
    const y   = PAD.t + ph * (1 - t/YTICKS);
    const val = yMin + yRange * (t/YTICKS);
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W-PAD.r, y); ctx.stroke();
    ctx.fillText(val.toFixed(8), PAD.l - 4, y + 4);
  }

  // Labels X
  ctx.textAlign = 'center';
  const XTICKS = 5;
  for (let t = 0; t <= XTICKS; t++) {
    const x   = PAD.l + pw * (t/XTICKS);
    const idx = lo + Math.floor((count-1) * (t/XTICKS));
    const lbl = new Date(data[idx].ts).toLocaleTimeString('fr-FR',{hour12:false});
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillText(lbl, x, H - 6);
    ctx.strokeStyle = J_GRID;
    ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, H-PAD.b); ctx.stroke();
  }

  // Courbe
  ctx.strokeStyle = J_COLORS[id];
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  let first = true;
  for (let i = lo; i <= hi; i += step) {
    const x = PAD.l + pw * ((i - lo) / (count - 1));
    const y = PAD.t + ph * (1 - (data[i].value - yMin) / yRange);
    first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    first = false;
  }
  ctx.stroke();

  // Tooltip survol
  const hov = jHover[id];
  if (hov && hov.idx >= lo && hov.idx <= hi) {
    const fracInView = (hov.idx - lo) / (count - 1);
    const tx = PAD.l + pw * fracInView;
    const ty = PAD.t + ph * (1 - (data[hov.idx].value - yMin) / yRange);

    // Croix
    ctx.strokeStyle = J_COLORS[id];
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(tx, PAD.t); ctx.lineTo(tx, H - PAD.b); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD.l, ty); ctx.lineTo(W - PAD.r, ty); ctx.stroke();
    ctx.globalAlpha = 1;

    // Point
    ctx.beginPath();
    ctx.arc(tx, ty, 4, 0, Math.PI * 2);
    ctx.fillStyle = J_COLORS[id];
    ctx.fill();

    // Étiquette
    const valTxt  = data[hov.idx].value.toFixed(8);
    const timeTxt = new Date(data[hov.idx].ts).toLocaleTimeString('fr-FR', {hour12:false});
    const line1   = valTxt + ' mbar';
    const line2   = timeTxt;
    ctx.font = 'bold 11px Consolas,monospace';
    const tw = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width);
    const bw = tw + 14, bh = 36;
    let bx = tx + 10;
    let by = ty - bh - 6;
    if (bx + bw > W - PAD.r) bx = tx - bw - 10;
    if (by < PAD.t) by = ty + 8;

    ctx.fillStyle = 'rgba(15,20,30,0.88)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 4);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.font = 'bold 11px Consolas,monospace';
    ctx.fillText(line1, bx + 7, by + 14);
    ctx.font = '10px Consolas,monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(line2, bx + 7, by + 28);
  }

  // Hint zoom si zoom actif
  if (z.lo !== null) {
    ctx.fillStyle = 'rgba(2,132,199,0.6)';
    ctx.font = '10px Consolas,monospace';
    ctx.textAlign = 'right';
    ctx.fillText('Double-clic pour reset zoom', W - PAD.r - 4, PAD.t + 12);
  }
}

// Remplacer drawJauge pour les graphes pression
function drawJauge(id) {
  const st = jState[id];
  if (!st.data.length) return;
  document.getElementById('standby-'+id).style.display = 'none';
  document.getElementById('wrap-'+id).style.display    = 'block';
  drawJaugeCanvas(id);
}
// ═══════════════════════════════════════════════════════════════════════
//  ÉTAT
// ═══════════════════════════════════════════════════════════════════════
const qState = {
  masses:[], signals:[], cycle:0,
  prevMasses:[], prevSignals:[],
  tCycle:0, tTotal:0,
  running: false,
  saving: false,
};
const jState = {
  j1:{ winMin:1, slider:100, data:[] },
  j2:{ winMin:1, slider:100, data:[] },
  running: false,
};
let allScans = [], selIdx = null;

// ═══════════════════════════════════════════════════════════════════════
//  CONTRÔLES QUAD
// ═══════════════════════════════════════════════════════════════════════
let selectedSpeed = '1';

function selectSpeed(btn, val) {
  if (qState.running) return; // pas de modif pendant scan
  selectedSpeed = val;
  document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function setControlsDisabled(disabled) {
  ['cfg-mmin','cfg-mmax','cfg-nscans'].forEach(id => {
    document.getElementById(id).disabled = disabled;
  });
  document.querySelectorAll('.speed-btn').forEach(b => b.disabled = disabled);
  document.getElementById('btn-save').disabled = !disabled; // Save actif seulement quand scan actif
}

function toggleSave() {
  if (!qState.saving) {
    const prefix = document.getElementById('quad-prefix')?.value.trim() || '';
    const suffix = document.getElementById('quad-suffix')?.value.trim() || '';
    sendCmd('quad_save', { prefix, suffix });
  } else {
    sendCmd('quad_save');
  }
}

function updateQuadFnamePreview() {
  const pre = document.getElementById('quad-prefix')?.value.trim() || '';
  const suf = document.getElementById('quad-suffix')?.value.trim() || '';
  const mid = 'SCAN_date_heure';
  const parts = [pre, mid, suf].filter(Boolean);
  const el = document.getElementById('quad-fname-preview');
  if (el) el.textContent = parts.join('_');
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('quad-prefix')?.addEventListener('input', updateQuadFnamePreview);
  document.getElementById('quad-suffix')?.addEventListener('input', updateQuadFnamePreview);
});

function setSaveState(saving, filename) {
  qState.saving = saving;
  const btn = document.getElementById('btn-save');
  const txt = document.getElementById('btn-save-txt');
  const inf = document.getElementById('save-info');
  btn.classList.toggle('active', saving);
  txt.textContent = saving ? 'STOP SAVE' : 'SAVE DATA';
  if (saving && filename) {
    inf.textContent = `💾 Enregistrement → DATA/${filename}`;
    inf.style.color = 'var(--green)';
  } else {
    inf.textContent = saving ? '💾 Enregistrement en cours...' : '—';
    inf.style.color = saving ? 'var(--green)' : 'var(--muted)';
  }
}

function updateJaugeFnamePreview() {
  const pre = document.getElementById('jauge-prefix').value.trim();
  const suf = document.getElementById('jauge-suffix').value.trim();
  const mid = 'JAUGE_date_heure';
  const parts = [pre, mid, suf].filter(Boolean);
  document.getElementById('jauge-fname-preview').textContent = parts.join('_');
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('jauge-prefix')?.addEventListener('input', updateJaugeFnamePreview);
  document.getElementById('jauge-suffix')?.addEventListener('input', updateJaugeFnamePreview);
});
// ═══════════════════════════════════════════════════════════════════════
function toggleQuad() {
  if (!qState.running) {
    const cfg = {
      startMass: parseFloat(document.getElementById('cfg-mmin').value)  || 3,
      endMass:   parseFloat(document.getElementById('cfg-mmax').value)   || 70,
      nScans:    parseInt(document.getElementById('cfg-nscans').value)   || 999,
      speed:     selectedSpeed,
    };
    sendCmd('quad_start', { cfg });
  } else {
    sendCmd('quad_stop');
  }
}
function toggleJauge() {
  if (!jState.running) {
    const prefix = document.getElementById('jauge-prefix').value.trim();
    const suffix = document.getElementById('jauge-suffix').value.trim();
    sendCmd('jauge_start', { prefix, suffix });
  } else {
    sendCmd('jauge_stop');
  }
}

function setQuadRunning(running) {
  qState.running = running;
  const btn = document.getElementById('btn-quad');
  const txt = document.getElementById('btn-quad-txt');
  btn.className = 'run-btn ' + (running ? 'running' : 'stopped');
  txt.textContent = running ? 'STOP QUAD' : 'START QUAD';
  setControlsDisabled(running);

  if (!running) {
    document.getElementById('standby-lin').style.display = 'flex';
    document.getElementById('standby-log').style.display = 'flex';
    document.getElementById('wrap-lin').style.display    = 'none';
    document.getElementById('wrap-log').style.display    = 'none';
    setSaveState(false);
  }
}

function setJaugeRunning(running) {
  jState.running = running;
  const btn = document.getElementById('btn-jauge');
  const txt = document.getElementById('btn-jauge-txt');
  btn.className = 'run-btn ' + (running ? 'running' : 'stopped');
  txt.textContent = running ? 'STOP JAUGE' : 'START JAUGE';
  // Ne pas cacher le graphe ni effacer les données au Stop
  // Le graphe reste visible avec les dernières données
}

// ═══════════════════════════════════════════════════════════════════════
//  PEAKS
// ═══════════════════════════════════════════════════════════════════════
// Masses caractéristiques — { masse: { label, formule, couleur } }
const SPECIES = {
   2: { label: 'H₂',   formule: 'Hydrogène',     color: '#60a5fa' },
   4: { label: 'He',   formule: 'Hélium',         color: '#a78bfa' },
  14: { label: 'N',    formule: 'Azote (frag.)',   color: '#6ee7b7' },
  15: { label: 'CH₃',  formule: 'Méthane (frag.)', color: '#fcd34d' },
  16: { label: 'O/CH₄',formule: 'Oxygène/Méthane', color: '#fca5a5' },
  17: { label: 'OH',   formule: 'Eau (frag.)',     color: '#93c5fd' },
  18: { label: 'H₂O',  formule: 'Eau',             color: '#38bdf8' },
  20: { label: 'HF',   formule: 'Fluorure HF',     color: '#f9a8d4' },
  28: { label: 'CO/N₂',formule: 'CO / Azote',      color: '#fdba74' },
  32: { label: 'O₂/S', formule: 'Oxygène / Soufre',color: '#34d399' },
  34: { label: 'H₂S',  formule: 'Sulfure H₂S',    color: '#fbbf24' },
  36: { label: 'HCl',  formule: 'Chlorure HCl',   color: '#f87171' },
  40: { label: 'Ar',   formule: 'Argon',           color: '#c084fc' },
  44: { label: 'CO₂',  formule: 'CO₂',             color: '#fb923c' },
  48: { label: 'SO',   formule: 'Oxyde SO',        color: '#e879f9' },
  64: { label: 'SO₂',  formule: 'Dioxyde SO₂',    color: '#f472b6' },
};
const SPECIES_MASSES = Object.keys(SPECIES).map(Number);

function updatePeaks(masses, signals) {
  // Trouver le signal max pour chaque masse caractéristique (±0.4 uma)
  const found = {};
  masses.forEach((m, i) => {
    const rounded = Math.round(m);
    if (!SPECIES[rounded]) return;
    const diff = Math.abs(m - rounded);
    if (diff > 0.4) return;
    const s = Math.abs(signals[i]);
    if (!found[rounded] || s > found[rounded].signal)
      found[rounded] = { signal: s, mass: m };
  });

  const el = document.getElementById('peaks-list');
  if (!Object.keys(found).length) {
    el.innerHTML = '<span style="color:var(--muted);font-size:11px">En attente des données...</span>';
    return;
  }

  el.innerHTML = SPECIES_MASSES.map(mz => {
    const sp  = SPECIES[mz];
    const hit = found[mz];
    const sig = hit ? hit.signal.toExponential(2) : '—';
    const dim = hit ? '' : 'opacity:0.3;';
    return `
    <div class="peak-item" style="${dim}border-color:${sp.color}22">
      <div class="peak-rank" style="color:${sp.color}">${sp.label}</div>
      <div class="peak-mass">${mz}</div>
      <div class="peak-sig">${sig}</div>
      <div style="font-size:8px;color:var(--muted);letter-spacing:0;margin-top:1px">${sp.formule}</div>
    </div>`;
  }).join('');
}

// Throttle quad : max 5 renders/sec
let _quadDirty = false;
function scheduleQuadDraw() { _quadDirty = true; }

function updateQuadAxisRange(startMass, endMass) {
  if (!startMass || !endMass) return;
  [chartLin, chartLog].forEach(c => {
    c.options.scales.x.min = startMass - 1;
    c.options.scales.x.max = endMass + 1;
  });
}

function drawQuad() {
  const { masses, signals, cycle, prevMasses, prevSignals, tCycle, tTotal } = qState;
  if (!masses.length) return;

  document.getElementById('standby-lin').style.display = 'none';
  document.getElementById('standby-log').style.display = 'none';
  document.getElementById('wrap-lin').style.display    = 'block';
  document.getElementById('wrap-log').style.display    = 'block';

  // Convertir en {x, y} pour axe X numérique fixe
  const pts     = masses.map((m,i) => ({ x: m, y: signals[i] }));
  const ptsLog  = masses.map((m,i) => ({ x: m, y: Math.abs(signals[i]) + 1e-12 }));
  const prevPts    = prevMasses.map((m,i) => ({ x: m, y: prevSignals[i] }));
  const prevPtsLog = prevMasses.map((m,i) => ({ x: m, y: Math.abs(prevSignals[i]) + 1e-12 }));

  chartLin.data.datasets[0].data = pts;
  chartLin.data.datasets[1].data = prevPts;
  chartLin.data.datasets[0].label = `Cycle ${cycle}`;
  chartLin.data.datasets[1].label = cycle > 1 ? `Cycle ${cycle - 1}` : 'Précédent';
  chartLin.update('none');

  chartLog.data.datasets[0].data = ptsLog;
  chartLog.data.datasets[1].data = prevPtsLog;
  chartLog.data.datasets[0].label = `Cycle ${cycle}`;
  chartLog.data.datasets[1].label = cycle > 1 ? `Cycle ${cycle - 1}` : 'Précédent';
  chartLog.update('none');

  document.getElementById('q-cycle').textContent = cycle;
  document.getElementById('q-pts').textContent   = masses.length;
  document.getElementById('q-mmin').textContent  = Math.min(...masses).toFixed(1);
  document.getElementById('q-mmax').textContent  = Math.max(...masses).toFixed(1);
  document.getElementById('q-smax').textContent  = Math.max(...signals.map(Math.abs)).toExponential(2);
  document.getElementById('q-tc').textContent    = tCycle.toFixed(1) + ' s';
  document.getElementById('q-tt').textContent    = tTotal.toFixed(1) + ' s';
  document.getElementById('scan-label-lin').textContent = `Cycle ${cycle}`;
  document.getElementById('scan-label-log').textContent = `Cycle ${cycle}`;
  updatePeaks(masses, signals);
}

// ═══════════════════════════════════════════════════════════════════════
//  HISTORIQUE
// ═══════════════════════════════════════════════════════════════════════
function renderPills(scans) {
  const el = document.getElementById('scan-list');
  if (!scans.length) { el.innerHTML = '<span style="font-size:11px;color:var(--muted)">Aucun scan terminé</span>'; return; }
  el.innerHTML = scans.slice().reverse().map((s,i) => {
    const idx = scans.length-1-i;
    return `<div class="scan-pill ${idx===selIdx?'active':''}" onclick="showHist(${idx})">Cycle ${s.cycle}</div>`;
  }).join('');
}
function showHist(idx) {
  selIdx = idx;
  const scan = allScans[idx]; if (!scan) return;
  document.getElementById('hist-section').style.display = 'block';
  const lbl = `— Cycle ${scan.cycle}`;
  document.getElementById('hist-label-lin').textContent = lbl;
  document.getElementById('hist-label-log').textContent = lbl;
  const labels = scan.masses.map(m => m.toFixed(1));
  chartHistLin.data.labels = labels;
  chartHistLin.data.datasets[0].data = scan.signals;
  chartHistLin.update('none');
  chartHistLog.data.labels = labels;
  chartHistLog.data.datasets[0].data = scan.signals.map(s=>Math.abs(s)+1e-12);
  chartHistLog.update('none');
  renderPills(allScans);
}

// ═══════════════════════════════════════════════════════════════════════
//  JAUGE — throttle à 2 fps max, max 3000 pts en mémoire par canal
// ═══════════════════════════════════════════════════════════════════════