const MAX_J_PTS = 1728000; // 24h à 20 Hz

function setWindow(min, id, btn) {
  jState[id].winMin = min;
  jState[id].slider = 100;
  document.getElementById('slider-'+id).value = 100;
  document.getElementById('slabel-'+id).textContent = 'En direct';
  // Bouton Tout
  document.getElementById('wbtn-tout-'+id).classList.toggle('active', min === 0);
  _jDirty[id] = true;
}

function setWindowCustom(id) {
  const val  = parseFloat(document.getElementById('win-'+id).value) || 1;
  const unit = parseFloat(document.getElementById('wunit-'+id).value);
  const min  = val * unit; // convertir en minutes
  jState[id].winMin = min;
  jState[id].slider = 100;
  document.getElementById('slider-'+id).value = 100;
  document.getElementById('slabel-'+id).textContent = 'En direct';
  document.getElementById('wbtn-tout-'+id).classList.remove('active');
  _jDirty[id] = true;
}
// ═══════════════════════════════════════════════════════════════════════
//  DOUBLE SLIDER
// ═══════════════════════════════════════════════════════════════════════
// État par canal : lo/hi en % (0-100)
const dSlider = {
  j1: { lo: 0, hi: 100 },
  j2: { lo: 0, hi: 100 },
};

function formatSliderTs(data, pct) {
  if (!data.length) return '—';
  if (pct >= 100) return 'En direct';
  if (pct <= 0)   return new Date(data[0].ts).toLocaleTimeString('fr-FR',{hour12:false});
  const idx = Math.floor(pct / 100 * (data.length - 1));
  return new Date(data[idx].ts).toLocaleTimeString('fr-FR',{hour12:false});
}

function updateDSlider(id) {
  const s    = dSlider[id];
  const data = jState[id].data;
  // Mise à jour visuelle
  document.getElementById('drange-'+id).style.left  = s.lo + '%';
  document.getElementById('drange-'+id).style.right = (100 - s.hi) + '%';
  document.getElementById('dthumb-'+id+'-lo').style.left = s.lo + '%';
  document.getElementById('dthumb-'+id+'-hi').style.left = s.hi + '%';
  document.getElementById('dlabel-'+id+'-lo').textContent = formatSliderTs(data, s.lo);
  document.getElementById('dlabel-'+id+'-hi').textContent = formatSliderTs(data, s.hi);

  // Appliquer à jZoom
  if (!data.length) return;
  const n   = data.length - 1;
  const lo  = Math.floor(s.lo / 100 * n);
  const hi  = Math.min(n, Math.round(s.hi / 100 * n));
  jZoom[id].lo = lo;
  jZoom[id].hi = hi;
  // Si hi = 100% → "En direct", pas de zoom bloqué
  if (s.hi >= 99 && s.lo <= 0) { jZoom[id].lo = null; jZoom[id].hi = null; }
  _jDirty[id] = true;
}

// Initialiser les interactions drag sur les thumbs
function initDSliders() {
  ['j1','j2'].forEach(id => {
    ['lo','hi'].forEach(side => {
      const thumb = document.getElementById(`dthumb-${id}-${side}`);
      if (!thumb || thumb._dsInit) return;
      thumb._dsInit = true;

      let dragging = false;
      thumb.addEventListener('mousedown', (e) => {
        dragging = true; thumb.classList.add('dragging'); e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const container = document.getElementById('dslider-'+id);
        const rect = container.getBoundingClientRect();
        let pct = Math.max(0, Math.min(100, (e.clientX - rect.left) / rect.width * 100));
        const s = dSlider[id];
        if (side === 'lo') { s.lo = Math.min(pct, s.hi - 1); }
        else               { s.hi = Math.max(pct, s.lo + 1); }
        updateDSlider(id);
      });
      window.addEventListener('mouseup', () => {
        if (dragging) { dragging = false; thumb.classList.remove('dragging'); }
      });

      // Touch support
      thumb.addEventListener('touchstart', (e) => {
        dragging = true; thumb.classList.add('dragging'); e.preventDefault();
      }, {passive:false});
      window.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const container = document.getElementById('dslider-'+id);
        const rect = container.getBoundingClientRect();
        const touch = e.touches[0];
        let pct = Math.max(0, Math.min(100, (touch.clientX - rect.left) / rect.width * 100));
        const s = dSlider[id];
        if (side === 'lo') { s.lo = Math.min(pct, s.hi - 1); }
        else               { s.hi = Math.max(pct, s.lo + 1); }
        updateDSlider(id);
      }, {passive:false});
      window.addEventListener('touchend', () => {
        if (dragging) { dragging = false; thumb.classList.remove('dragging'); }
      });
    });

    // Reset double-clic sur la piste
    document.getElementById('dslider-'+id)?.addEventListener('dblclick', () => {
      dSlider[id].lo = 0; dSlider[id].hi = 100;
      jZoom[id].lo = null; jZoom[id].hi = null;
      updateDSlider(id);
    });
  });
}

// Mettre à jour les sliders quand de nouvelles données arrivent
function refreshDSliders() {
  ['j1','j2'].forEach(id => {
    const s = dSlider[id];
    // Si hi = 100 (en direct), laisser le thumb de droite suivre automatiquement
    if (s.hi >= 99) updateDSlider(id);
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  LASER
// ═══════════════════════════════════════════════════════════════════════
let selectedProg = 'siderite';

// Séquences miroir du serveur (pour affichage des steps)
const LASER_STEPS = {
  siderite: (() => {
    const s = [];
    for (let p = 0; p <= 4000; p += 100) s.push({ power:p, label:`${p}` });
    s.push({ power:4000, label:'4000↓', palier:true });
    return s;
  })(),
  chondrite: (() => {
    const s = [];
    for (let p = 0; p <= 4000; p += 100) s.push({ power:p, label:`${p}` });
    [4000,5000,6000,7000,8000,9000].forEach(p => s.push({ power:p, label:`${p}`, palier:true }));
    return s;
  })(),
};

function selectProg(prog) {
  if (laserRunning) return;
  selectedProg = prog;
  document.getElementById('prog-siderite').classList.toggle('active',  prog==='siderite');
  document.getElementById('prog-chondrite').classList.toggle('active', prog==='chondrite');
  document.getElementById('prog-custom').classList.toggle('active',    prog==='custom');
  document.getElementById('custom-power-group').style.display = prog==='custom' ? 'flex' : 'none';
  renderLaserSteps(prog, null);
  renderLaserMarkers(prog);
}

let laserRunning = false;
let laserElapsedTimer = null;
let laserStartTs = null;

function toggleLaser() {
  if (!laserRunning) {
    const extra = { programme: selectedProg };
    if (selectedProg === 'custom') {
      const pw = parseInt(document.getElementById('custom-power').value) || 5000;
      extra.customPower = Math.max(100, Math.min(10000, pw));
    }
    sendCmd('laser_start', extra);
  } else {
    sendCmd('laser_stop');
  }
}

function setLaserRunning(running) {
  laserRunning = running;
  const btn = document.getElementById('btn-laser');
  const txt = document.getElementById('btn-laser-txt');
  btn.className = 'run-btn ' + (running ? 'running' : 'stopped');
  txt.textContent = running ? 'STOP LASER' : 'START LASER';
  document.getElementById('prog-siderite').disabled  = running;
  document.getElementById('prog-chondrite').disabled = running;
  if (running) {
    laserStartTs = Date.now();
    laserElapsedTimer = setInterval(() => {
      const s = Math.round((Date.now() - laserStartTs) / 1000);
      const m = Math.floor(s/60), sec = s%60;
      document.getElementById('laser-elapsed').textContent = `${m}min ${sec}s`;
    }, 1000);
  } else {
    clearInterval(laserElapsedTimer);
    if (!running) document.getElementById('laser-elapsed').textContent = '';
  }
}

function updateLaserUI(st) {
  const MAX_POWER = 10000;
  const pct = (st.power / MAX_POWER) * 100;
  document.getElementById('laser-power-bar').style.height = pct + '%';
  document.getElementById('laser-power-val').textContent = st.power;
  document.getElementById('laser-progress-bar').style.width = st.progress + '%';
  document.getElementById('laser-progress-val').textContent = st.progress + ' %';
  document.getElementById('laser-phase').textContent = st.message || st.phase || '—';

  if (st.programme) renderLaserSteps(st.programme, st.power);
  if (st.startTime && laserStartTs === null && st.running) laserStartTs = st.startTime;
}

function renderLaserSteps(prog, currentPower) {
  const steps = prog === 'custom'
    ? buildCustomSteps(parseInt(document.getElementById('custom-power')?.value) || 5000)
    : LASER_STEPS[prog];
  if (!steps) return;
  const paliers = steps.filter(s => s.palier || s.power === 0 || s.power % 1000 === 0);
  const el = document.getElementById('laser-steps');
  el.innerHTML = paliers.map(s => {
    let cls = 'laser-step';
    if (currentPower !== null) {
      if (s.power < currentPower)      cls += ' done';
      else if (s.power === currentPower) cls += ' current';
    }
    return `<div class="${cls}">${s.power} mA</div>`;
  }).join('');
}

function renderLaserMarkers(prog) {
  const maxPow = prog === 'custom'
    ? (parseInt(document.getElementById('custom-power')?.value) || 5000)
    : (prog === 'chondrite' ? 9000 : 4000);
  const MAX = 10000;
  const el = document.getElementById('laser-markers');
  if (!el) return;
  const ticks = [];
  for (let p = 1000; p <= maxPow; p += 1000) ticks.push(p);
  // Barre verticale : bottom = 0%, top = 100%
  el.innerHTML = ticks.map(p => {
    const bottom = (p/MAX*100).toFixed(1);
    return `<div style="position:absolute;left:0;right:0;bottom:${bottom}%;height:1px;background:rgba(0,0,0,.2)"></div>`;
  }).join('');
}

function buildCustomSteps(maxPower) {
  const steps = [];
  for (let p = 0; p <= maxPower; p += 100)
    steps.push({ power: p, label: `${p}`, palier: p % 1000 === 0 && p > 0 });
  steps.push({ power: maxPower, label: `${maxPower}↓`, palier: true });
  return steps;
}

// Init affichage
function initJauge() {
  renderLaserSteps('siderite', null);
  renderLaserMarkers('siderite');
}

// ═══════════════════════════════════════════════════════════════════════
//  PLEIN ÉCRAN JAUGE
// ═══════════════════════════════════════════════════════════════════════
let fsChannel = null;
let fsRenderInterval = null;
const dSliderFs = { lo: 0, hi: 100 };
const jZoomFs   = { lo: null, hi: null, dragging: false, dragStartX: 0, dragStartLo: 0, dragStartHi: 0 };

function updateFsSlider() {
  if (!fsChannel) return;
  const data = jState[fsChannel].data;
  document.getElementById('drange-fs').style.left  = dSliderFs.lo + '%';
  document.getElementById('drange-fs').style.right = (100 - dSliderFs.hi) + '%';
  document.getElementById('dthumb-fs-lo').style.left = dSliderFs.lo + '%';
  document.getElementById('dthumb-fs-hi').style.left = dSliderFs.hi + '%';
  document.getElementById('dlabel-fs-lo').textContent = formatSliderTs(data, dSliderFs.lo);
  document.getElementById('dlabel-fs-hi').textContent = formatSliderTs(data, dSliderFs.hi);
}

let jHoverFs = null;

function getFsBounds() {
  if (!fsChannel) return { lo:0, hi:0 };
  const data = jState[fsChannel].data;
  if (!data.length) return { lo:0, hi:0 };
  if (jZoomFs.lo !== null) return { lo: jZoomFs.lo, hi: jZoomFs.hi };
  const n  = data.length - 1;
  const lo = Math.floor(dSliderFs.lo / 100 * n);
  const hi = Math.min(n, Math.round(dSliderFs.hi / 100 * n));
  return { lo, hi };
}

function openFullscreen(id) {
  fsChannel = id;
  dSliderFs.lo = 0; dSliderFs.hi = 100;
  jZoomFs.lo = null; jZoomFs.hi = null;
  document.getElementById('fs-modal').classList.add('open');
  document.getElementById('fs-title').textContent = id==='j1' ? 'Pression 1 — historique' : 'Pression 2 — historique';
  document.getElementById('fs-p-label').textContent = id==='j1' ? 'PRESSION 1' : 'PRESSION 2';
  document.getElementById('fs-p-val').style.color = id==='j1' ? 'var(--accent)' : 'var(--cyan)';
  document.getElementById('fs-win').value   = document.getElementById('win-'+id).value;
  document.getElementById('fs-wunit').value = document.getElementById('wunit-'+id).value;
  dSliderFs.lo = dSlider[id].lo;
  dSliderFs.hi = dSlider[id].hi;
  initFsInteraction();
  fsRenderInterval = setInterval(() => {
    try {
      if (!fsChannel) return;
      if (dSliderFs.hi >= 99) updateFsSlider();
      drawFsCanvas();
      const rawVal = jState[fsChannel].data.at(-1)?.value;
      if (rawVal != null) {
        document.getElementById('fs-p-val').textContent = rawVal.toFixed(8);
      }
      document.getElementById('fs-laser-bar').style.height   = document.getElementById('laser-power-bar').style.height;
      document.getElementById('fs-laser-val').textContent    = document.getElementById('laser-power-val').textContent;
      document.getElementById('fs-laser-phase').textContent  = document.getElementById('laser-phase').textContent;
    } catch(e) { console.warn('fsRender error:', e); }
  }, 1000);
  updateFsSlider();
  document.body.style.overflow = 'hidden';
}

function closeFullscreen() {
  document.getElementById('fs-modal').classList.remove('open');
  clearInterval(fsRenderInterval); fsRenderInterval = null;
  fsChannel = null;
  document.body.style.overflow = '';
}

document.addEventListener('keydown', e => { if (e.key==='Escape' && fsChannel) closeFullscreen(); });

function fsSetWindow() {
  if (!fsChannel) return;
  const val  = parseFloat(document.getElementById('fs-win').value) || 1;
  const unit = parseFloat(document.getElementById('fs-wunit').value);
  jState[fsChannel].winMin = val * unit;
  const data = jState[fsChannel].data;
  if (data.length && jState[fsChannel].winMin > 0) {
    const durMs = jState[fsChannel].winMin * 60 * 1000;
    const from  = data[data.length-1].ts - durMs;
    let a=0, b=data.length-1;
    while(a<b){const mid=(a+b)>>1; data[mid].ts<from?a=mid+1:b=mid;}
    dSliderFs.lo = a/(data.length-1)*100;
    dSliderFs.hi = 100;
  }
  document.getElementById('fs-btn-tout').classList.remove('active');
  jZoomFs.lo=null; jZoomFs.hi=null;
  updateFsSlider(); drawFsCanvas();
}

function fsSetWindowAll() {
  if (!fsChannel) return;
  jState[fsChannel].winMin = 0;
  dSliderFs.lo=0; dSliderFs.hi=100;
  jZoomFs.lo=null; jZoomFs.hi=null;
  document.getElementById('fs-btn-tout').classList.add('active');
  updateFsSlider(); drawFsCanvas();
}

function fsOnSlider(val) {}

function drawFsCanvas() {
  if (!fsChannel) return;
  const data = jState[fsChannel].data;
  const cvs  = document.getElementById('canvas-fs');
  if (!cvs) return;
  const dpr=window.devicePixelRatio||1, W=cvs.clientWidth, H=cvs.clientHeight;
  if(cvs.width!==W*dpr||cvs.height!==H*dpr){cvs.width=W*dpr;cvs.height=H*dpr;}
  const ctx=cvs.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,W,H);
  if (!data.length) {
    ctx.fillStyle='rgba(0,0,0,.3)';ctx.font='14px Consolas,monospace';ctx.textAlign='center';
    ctx.fillText('En attente des données...',W/2,H/2); return;
  }
  const { lo, hi } = getFsBounds();
  const count=hi-lo+1; if(count<2) return;
  let yMin=Infinity,yMax=-Infinity;
  const step=Math.ceil(count/2000);
  for(let i=lo;i<=hi;i+=step){if(data[i].value<yMin)yMin=data[i].value;if(data[i].value>yMax)yMax=data[i].value;}
  const fsRange=(yMax-yMin)||yMax*0.1||1e-12;
  yMin=Math.max(0,yMin-fsRange*0.1); yMax=yMax+fsRange*0.1;
  const yRange=yMax-yMin||1e-10;
  const PAD={t:10,b:32,l:110,r:12}, pw=W-PAD.l-PAD.r, ph=H-PAD.t-PAD.b;
  ctx.strokeStyle='rgba(0,0,0,.07)';ctx.lineWidth=0.5;
  ctx.fillStyle='rgba(0,0,0,.45)';ctx.font='12px Consolas,monospace';ctx.textAlign='right';
  for(let t=0;t<=5;t++){
    const y=PAD.t+ph*(1-t/5),val=yMin+yRange*(t/5);
    ctx.beginPath();ctx.moveTo(PAD.l,y);ctx.lineTo(W-PAD.r,y);ctx.stroke();
    ctx.fillText(val.toFixed(8),PAD.l-4,y+4);
  }
  ctx.textAlign='center';
  for(let t=0;t<=6;t++){
    const x=PAD.l+pw*(t/6),idx=lo+Math.floor((count-1)*(t/6));
    ctx.fillStyle='rgba(0,0,0,.45)';ctx.fillText(new Date(data[idx].ts).toLocaleTimeString('fr-FR',{hour12:false}),x,H-8);
    ctx.strokeStyle='rgba(0,0,0,.07)';ctx.beginPath();ctx.moveTo(x,PAD.t);ctx.lineTo(x,H-PAD.b);ctx.stroke();
  }
  ctx.strokeStyle=fsChannel==='j1'?'#c0390f':'#0284c7';
  ctx.lineWidth=2;ctx.lineJoin='round';ctx.beginPath();
  let first=true;
  for(let i=lo;i<=hi;i+=step){
    const x=PAD.l+pw*((i-lo)/(count-1)),y=PAD.t+ph*(1-(data[i].value-yMin)/yRange);
    first?ctx.moveTo(x,y):ctx.lineTo(x,y);first=false;
  }
  ctx.stroke();

  // Tooltip survol plein écran
  if (jHoverFs && jHoverFs.idx >= lo && jHoverFs.idx <= hi) {
    const fracInView = (jHoverFs.idx - lo) / (count - 1);
    const tx = PAD.l + pw * fracInView;
    const ty = PAD.t + ph * (1 - (data[jHoverFs.idx].value - yMin) / yRange);
    const color = fsChannel==='j1' ? '#c0390f' : '#0284c7';

    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(tx, PAD.t); ctx.lineTo(tx, H-PAD.b); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD.l, ty); ctx.lineTo(W-PAD.r, ty); ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.beginPath(); ctx.arc(tx, ty, 4, 0, Math.PI*2);
    ctx.fillStyle = color; ctx.fill();

    const valTxt  = data[jHoverFs.idx].value.toFixed(8);
    const timeTxt = new Date(data[jHoverFs.idx].ts).toLocaleTimeString('fr-FR',{hour12:false});
    ctx.font = 'bold 12px Consolas,monospace';
    const tw = Math.max(ctx.measureText(valTxt).width, ctx.measureText(timeTxt).width);
    const bw = tw + 14, bh = 38;
    let bx = tx + 10, by = ty - bh - 8;
    if (bx + bw > W - PAD.r) bx = tx - bw - 10;
    if (by < PAD.t) by = ty + 8;

    ctx.fillStyle = 'rgba(15,20,30,0.88)';
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 4); ctx.fill();

    ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    ctx.font = 'bold 12px Consolas,monospace';
    ctx.fillText(valTxt+' mbar', bx+7, by+15);
    ctx.font = '10px Consolas,monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(timeTxt, bx+7, by+30);
  }
}

function initFsInteraction() {
  const cvs = document.getElementById('canvas-fs');
  if (cvs._fsInit) return; cvs._fsInit = true;
  cvs.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!fsChannel) return;
    const data=jState[fsChannel].data; if(!data.length) return;
    const {lo,hi}=getFsBounds(), count=hi-lo+1;
    const rect=cvs.getBoundingClientRect();
    const frac=Math.max(0,Math.min(1,(e.clientX-rect.left-88)/(rect.width-100)));
    const center=lo+frac*(count-1), half=(count/2)*(e.deltaY>0?1.25:0.8);
    jZoomFs.lo=Math.max(0,Math.round(center-half));
    jZoomFs.hi=Math.min(data.length-1,Math.round(center+half));
    if(jZoomFs.hi-jZoomFs.lo<2)jZoomFs.lo=Math.max(0,jZoomFs.hi-2);
    drawFsCanvas();
  },{passive:false});
  cvs.addEventListener('mousedown', (e) => {
    if(!fsChannel)return;
    const {lo,hi}=getFsBounds();
    jZoomFs.dragging=true;jZoomFs.dragStartX=e.clientX;
    jZoomFs.dragStartLo=lo;jZoomFs.dragStartHi=hi;
    cvs.style.cursor='grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    if(!jZoomFs.dragging||!fsChannel)return;
    const data=jState[fsChannel].data;if(!data.length)return;
    const rect=cvs.getBoundingClientRect(),pw=rect.width-100;
    const count=jZoomFs.dragStartHi-jZoomFs.dragStartLo+1;
    const shift=Math.round((e.clientX-jZoomFs.dragStartX)/pw*count);
    let lo=jZoomFs.dragStartLo-shift,hi=jZoomFs.dragStartHi-shift;
    if(lo<0){hi-=lo;lo=0;}if(hi>data.length-1){lo-=(hi-data.length+1);hi=data.length-1;}
    jZoomFs.lo=Math.max(0,lo);jZoomFs.hi=Math.min(data.length-1,hi);
    drawFsCanvas();
  });
  window.addEventListener('mouseup',()=>{
    if(jZoomFs.dragging){jZoomFs.dragging=false;const c=document.getElementById('canvas-fs');if(c)c.style.cursor='crosshair';}
  });
  cvs.addEventListener('dblclick',()=>{jZoomFs.lo=null;jZoomFs.hi=null;drawFsCanvas();});
  // Double slider FS
  ['lo','hi'].forEach(side => {
    const thumb=document.getElementById(`dthumb-fs-${side}`);
    if(!thumb||thumb._dsInit)return; thumb._dsInit=true;
    let dragging=false;
    thumb.addEventListener('mousedown',(e)=>{dragging=true;thumb.classList.add('dragging');e.preventDefault();e.stopPropagation();});
    window.addEventListener('mousemove',(e)=>{
      if(!dragging)return;
      const container=document.getElementById('dslider-fs');
      const rect=container.getBoundingClientRect();
      let pct=Math.max(0,Math.min(100,(e.clientX-rect.left)/rect.width*100));
      if(side==='lo')dSliderFs.lo=Math.min(pct,dSliderFs.hi-1);
      else            dSliderFs.hi=Math.max(pct,dSliderFs.lo+1);
      jZoomFs.lo=null;jZoomFs.hi=null;
      updateFsSlider();drawFsCanvas();
    });
    window.addEventListener('mouseup',()=>{if(dragging){dragging=false;thumb.classList.remove('dragging');}});
  });
  document.getElementById('dslider-fs')?.addEventListener('dblclick',()=>{
    dSliderFs.lo=0;dSliderFs.hi=100;jZoomFs.lo=null;jZoomFs.hi=null;
    updateFsSlider();drawFsCanvas();
  });

  // Survol → tooltip plein écran
  cvs.addEventListener('mousemove', (e) => {
    if (jZoomFs.dragging || !fsChannel) return;
    const data = jState[fsChannel].data;
    if (!data.length) { jHoverFs = null; return; }
    const rect = cvs.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const PAD_L = 88;
    if (mx < PAD_L || mx > rect.width - 12) { jHoverFs = null; drawFsCanvas(); return; }
    const {lo, hi} = getFsBounds();
    const count = hi - lo + 1;
    const pw    = rect.width - PAD_L - 12;
    const frac  = (mx - PAD_L) / pw;
    const idx   = Math.max(lo, Math.min(hi, Math.round(lo + frac * (count - 1))));
    jHoverFs = { idx };
    drawFsCanvas();
  });
  cvs.addEventListener('mouseleave', () => { jHoverFs = null; drawFsCanvas(); });
}


// ═══════════════════════════════════════════════════════════════════════
//  DATA ANALYSIS — sous-onglets iframe
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
//  SESSIONS JAUGE
// ═══════════════════════════════════════════════════════════════════════
const jaugeSessions = []; // { startTime, filename, data1, data2, btn }
let currentSessionIdx = null;

function addSessionButton(startTime, filename) {
  const ts  = new Date(startTime);
  const lbl = ts.toLocaleDateString('fr-FR') + ' ' + ts.toLocaleTimeString('fr-FR', {hour12:false});
  const idx = jaugeSessions.length;
  const session = { startTime, filename, data1: null, data2: null, lbl };
  jaugeSessions.push(session);
  currentSessionIdx = idx;

  const el = document.getElementById('jauge-sessions');
  // Retirer le message "Aucune session"
  el.querySelectorAll('span').forEach(s => s.remove());

  const btn = document.createElement('button');
  btn.className   = 'session-btn active';
  btn.dataset.idx = idx;
  btn.innerHTML   = `<span style="font-size:10px;display:block;color:var(--muted)">Session ${idx+1}</span>${lbl}<span id="sess-status-${idx}" style="font-size:10px;display:block;color:var(--cyan)">En cours...</span>`;
  btn.onclick     = () => showSession(idx);
  el.appendChild(btn);
  session.btn = btn;
}

function finalizeCurrentSession(data1, data2) {
  if (currentSessionIdx === null) return;
  const s = jaugeSessions[currentSessionIdx];
  if (!s) return;
  s.data1 = data1.slice();
  s.data2 = data2.slice();
  const pts = data1.length;
  const statusEl = document.getElementById(`sess-status-${currentSessionIdx}`);
  if (statusEl) {
    statusEl.textContent = `${pts.toLocaleString('fr-FR')} points`;
    statusEl.style.color = 'var(--green)';
  }
  if (s.btn) s.btn.classList.remove('active');
}

function saveJaugeSession() {
  // Appelé avant de démarrer une nouvelle session si des données existent
  if (currentSessionIdx !== null) {
    finalizeCurrentSession(jState.j1.data, jState.j2.data);
  }
}


function showSession(idx) {
  const s = jaugeSessions[idx];
  if (!s) return;

  // Mettre à jour les boutons
  document.querySelectorAll('.session-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.idx) === idx);
  });

  const data1 = s.data1 || (idx === currentSessionIdx ? jState.j1.data : []);
  const data2 = s.data2 || (idx === currentSessionIdx ? jState.j2.data : []);

  // Charger dans jState pour l'affichage
  jState.j1.data = data1;
  jState.j2.data = data2;
  jState.j1.winMin = 0; jState.j2.winMin = 0;
  resetJaugeZoom('j1'); resetJaugeZoom('j2');
  drawJauge('j1'); drawJauge('j2');

  document.getElementById('wbtn-tout-j1').classList.add('active');
  document.getElementById('wbtn-tout-j2').classList.add('active');
}

// ═══════════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════