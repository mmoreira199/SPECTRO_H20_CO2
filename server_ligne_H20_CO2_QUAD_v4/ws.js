
// ═══════════════════════════════════════════════════════════════════════
//  TABS
// ═══════════════════════════════════════════════════════════════════════
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) =>
    t.classList.toggle('active', ['quad','jauge','analysis','config'][i] === name));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
}

// ═══════════════════════════════════════════════════════════════════════

//  DATA ANALYSIS — sous-onglets iframe
// ═══════════════════════════════════════════════════════════════════════
function showAnalysisTool(idx) {
  [0,1,2,3].forEach(i => {
    document.getElementById('asub-'+i).classList.toggle('active', i===idx);
    document.getElementById('atool-'+i).style.display = i===idx ? 'block' : 'none';
  });
  if (idx === 3) loadDataFiles();
}

// ═══════════════════════════════════════════════════════════════════════
//  NAVIGATEUR DE FICHIERS DATA (lecture seule — fonctionne aussi en mode viewer)
// ═══════════════════════════════════════════════════════════════════════
let dataFilesCache = [];

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' Ko';
  return (bytes/(1024*1024)).toFixed(2) + ' Mo';
}

async function loadDataFiles() {
  const status = document.getElementById('datafiles-status');
  status.textContent = 'Chargement...';
  try {
    const r = await fetch('/api/data-files');
    dataFilesCache = await r.json();
    renderDataFiles();
  } catch (e) {
    status.textContent = '⚠ Impossible de charger la liste des fichiers (serveur inaccessible).';
    document.getElementById('datafiles-tbody').innerHTML = '';
  }
}

function renderDataFiles() {
  const filter = (document.getElementById('datafiles-filter').value || '').toLowerCase();
  const rows = dataFilesCache.filter(f => f.name.toLowerCase().includes(filter));
  const tbody = document.getElementById('datafiles-tbody');
  const status = document.getElementById('datafiles-status');

  status.textContent = dataFilesCache.length
    ? `${rows.length} fichier(s)` + (filter ? ` (sur ${dataFilesCache.length} au total)` : '')
    : 'Aucun fichier dans le dossier DATA (ou dossier inaccessible).';

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--muted)">Aucun fichier${filter?' correspondant':''}.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(f => {
    const isQuad  = /^SCAN_/i.test(f.name);
    const isJauge = /JAUGE/i.test(f.name);
    const icon = isQuad ? '📊' : isJauge ? '📈' : '📄';
    const dt = new Date(f.mtime).toLocaleString('fr-FR',{hour12:false});
    const url = '/api/data-files/download?name=' + encodeURIComponent(f.name);
    return `<tr style="border-top:1px solid var(--border)">
      <td style="padding:8px 14px;">${icon} ${f.name}</td>
      <td style="padding:8px 14px;color:var(--muted);white-space:nowrap;">${dt}</td>
      <td style="padding:8px 14px;color:var(--muted);white-space:nowrap;">${fmtSize(f.size)}</td>
      <td style="padding:8px 14px;text-align:right;"><a class="ctrl-btn" href="${url}" download style="text-decoration:none;display:inline-block;">↓ Télécharger</a></td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════
//  SESSIONS JAUGE
// ═══════════════════════════════════════════════════════════════════════
let ws=null, pingTimer=null, clockTimer=null, reconnDelay=1000;
const VIEWER_MODE = new URLSearchParams(location.search).get('viewer') === '1';

function sendCmd(cmd, extra) {
  if (VIEWER_MODE) return; // ceinture + bretelles : le serveur bloque aussi côté WS
  if (ws && ws.readyState===WebSocket.OPEN)
    ws.send(JSON.stringify({ cmd, ...extra }));
}

function copyViewerLink() {
  const url = location.origin + location.pathname + '?viewer=1';
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(() => {
      alert('Lien lecture seule copié :\n' + url + '\n\nÀ partager sur le réseau local (aucune connexion à modifier le labo ne sera possible).');
    }).catch(() => {
      prompt('Copie automatique impossible — copiez ce lien :', url);
    });
  } else {
    // navigator.clipboard n'existe qu'en contexte sécurisé (HTTPS/localhost) —
    // sur http://<ip-locale>:port (cas normal sur le réseau du labo), on retombe ici.
    prompt('Copiez ce lien lecture seule à partager sur le réseau local :', url);
  }
}

function applyViewerMode() {
  if (!VIEWER_MODE) return;
  document.body.classList.add('viewer-mode');
  const banner = document.createElement('div');
  banner.id = 'viewer-banner';
  banner.style = 'position:sticky;top:0;z-index:200;background:#f59e0b;color:#1e293b;'+
    'text-align:center;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px;';
  banner.textContent = '👁 MODE LECTURE SEULE — consultation uniquement, aucune commande possible';
  document.body.prepend(banner);
  // Désactiver tous les contrôles interactifs (boutons, inputs, onglet config)
  ['btn-quad','btn-jauge','btn-save','btn-laser','jauge-prefix','jauge-suffix',
   'quad-prefix','quad-suffix','cfg-mmin','cfg-mmax','cfg-nscans',
   'prog-siderite','prog-chondrite','prog-custom','custom-power'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = true;
  });
  document.querySelectorAll('.speed-btn').forEach(b => b.disabled = true);
  // Boutons "standby" alternatifs (▶ START QUAD/JAUGE affichés quand rien ne tourne)
  // — pas d'id, donc ciblés par classe ; sendCmd() les bloquait déjà, mais ça évite
  // l'illusion qu'ils font quelque chose.
  document.querySelectorAll('.standby-btn').forEach(b => {
    b.disabled = true;
    b.style.opacity = .5; b.style.cursor = 'not-allowed'; b.style.pointerEvents = 'none';
  });
  document.querySelectorAll('.tab').forEach(t => {
    if (t.textContent.includes('CONFIG')) { t.style.opacity = .4; t.style.pointerEvents = 'none'; }
  });
  // Empêcher tout accès à la page de config (modification des paramètres matériels)
  const cfgPage = document.getElementById('page-config');
  if (cfgPage) cfgPage.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">⚙ Configuration non accessible en mode lecture seule</div>';
}

function setPill(id, status) {
  const el = document.getElementById('pill-'+id);
  el.className = 'dpill ' + (status==='hw' ? 'hw' : status==='demo' ? 'demo' : 'err');
  el.textContent = id.toUpperCase() + (status==='demo' ? ' (DEMO)' : status==='hw' ? ' ✓' : '');
}

function connect() {
  ws = new WebSocket(`ws://${location.hostname}:${location.port||3000}${VIEWER_MODE ? '?viewer=1' : ''}`);

  ws.onopen = () => {
    reconnDelay = 1000;
    document.getElementById('hdot').className    = 'hdot live';
    document.getElementById('hconn').textContent = 'EN DIRECT';
    pingTimer  = setInterval(()=>{ if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({cmd:'ping',t:Date.now()})); }, 2000);
    clockTimer = setInterval(() => {
      const now = new Date();
      const hms = now.toLocaleTimeString('fr-FR', {hour12:false});
      const date = now.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long'});
      document.getElementById('htime').textContent = hms;
      const clockEl = document.getElementById('local-clock');
      const dateEl  = document.getElementById('local-date');
      if (clockEl) clockEl.textContent = hms;
      if (dateEl)  dateEl.textContent  = date;
      const fsClockEl = document.getElementById('fs-clock');
      const fsDateEl  = document.getElementById('fs-date');
      if (fsClockEl) fsClockEl.textContent = hms;
      if (fsDateEl)  fsDateEl.textContent  = date;
    }, 1000);
  };

  ws.onclose = () => {
    clearInterval(pingTimer); clearInterval(clockTimer);
    document.getElementById('hdot').className    = 'hdot err';
    document.getElementById('hconn').textContent = 'RECONNEXION...';
    setTimeout(connect, reconnDelay);
    reconnDelay = Math.min(reconnDelay*2, 15000);
  };

  ws.onerror = () => { document.getElementById('hdot').className = 'hdot err'; };

  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {

      case 'init': {
        setQuadRunning(msg.quadRunning  || false);
        setJaugeRunning(msg.jaugeRunning || false);
        if (msg.quadSaving) setSaveState(true, msg.quadFilename);
        if (msg.laserState) {
          setLaserRunning(msg.laserState.running);
          updateLaserUI(msg.laserState);
          if (msg.laserState.programme) {
            selectedProg = msg.laserState.programme;
            document.getElementById('prog-siderite').classList.toggle('active',  selectedProg==='siderite');
            document.getElementById('prog-chondrite').classList.toggle('active', selectedProg==='chondrite');
            renderLaserMarkers(selectedProg);
          }
        }
        if (msg.quadCfg) {
          document.getElementById('cfg-mmin').value   = msg.quadCfg.startMass;
          document.getElementById('cfg-mmax').value   = msg.quadCfg.endMass;
          document.getElementById('cfg-nscans').value = msg.quadCfg.nScans;
          selectedSpeed = String(msg.quadCfg.speed || '1');
          document.querySelectorAll('.speed-btn').forEach(b => {
            b.classList.toggle('active', b.textContent === selectedSpeed);
          });
          updateQuadAxisRange(msg.quadCfg.startMass, msg.quadCfg.endMass);
        }
        const q = msg.quad || {};
        if (q.masses?.length) {
          Object.assign(qState, { masses:q.masses, signals:q.signals, cycle:q.cycle,
            prevMasses:q.prevMasses||[], prevSignals:q.prevSignals||[], tCycle:0, tTotal:0 });
          scheduleQuadDraw();
        }
        const j = msg.jauge || {};
        if (j.p1 != null) {
          document.getElementById('j-p1').textContent  = j.p1.toFixed(8)
          document.getElementById('j-ts1').textContent = new Date(j.ts).toLocaleTimeString('fr-FR');
        }
        if (j.p2 != null) {
          document.getElementById('j-p2').textContent  = j.p2.toFixed(8)
          document.getElementById('j-ts2').textContent = new Date(j.ts).toLocaleTimeString('fr-FR');
        }
        if (j.history1?.length) { jState.j1.data = j.history1; drawJauge('j1'); }
        if (j.history2?.length) { jState.j2.data = j.history2; drawJauge('j2'); }
        break;
      }

      case 'quad_status': {
        setQuadRunning(msg.running);
        if (msg.saving !== undefined) setSaveState(msg.saving, msg.filename);
        if (!msg.running) {
          qState.masses=[]; qState.signals=[]; qState.cycle=0;
          qState.prevMasses=[]; qState.prevSignals=[];
        }
        // Mettre à jour les contrôles si le serveur envoie sa config
        if (msg.cfg) {
          document.getElementById('cfg-mmin').value   = msg.cfg.startMass;
          document.getElementById('cfg-mmax').value   = msg.cfg.endMass;
          document.getElementById('cfg-nscans').value = msg.cfg.nScans;
          if (msg.cfg.speed) {
            selectedSpeed = String(msg.cfg.speed);
            document.querySelectorAll('.speed-btn').forEach(b => {
              b.classList.toggle('active', b.textContent === selectedSpeed);
            });
          }
          updateQuadAxisRange(msg.cfg.startMass, msg.cfg.endMass);
        }
        break;
      }

      case 'jauge_status': {
        const wasRunning = jState.running;
        setJaugeRunning(msg.running);

        if (msg.running) {
          // Nouveau démarrage — effacer les données de la session précédente
          // mais sauvegarder d'abord la session courante si elle a des données
          if (jState.j1.data.length || jState.j2.data.length) {
            saveJaugeSession();
          }
          jState.j1.data = []; jState.j2.data = [];
          jState.j1.winMin = 1; jState.j2.winMin = 1;
          dSlider.j1.lo = 0; dSlider.j1.hi = 100;
          dSlider.j2.lo = 0; dSlider.j2.hi = 100;
          resetJaugeZoom('j1'); resetJaugeZoom('j2');
          // Afficher standby en attendant les premières données
          ['j1','j2'].forEach(id => {
            document.getElementById('standby-'+id).style.display = 'flex';
            document.getElementById('wrap-'+id).style.display    = 'none';
          });
          if (msg.filename) {
            const infoEl = document.getElementById('jauge-save-info');
            if (infoEl) { infoEl.textContent = `💾 Session en cours → DATA/${msg.filename}`; infoEl.style.color='var(--cyan)'; }
          }
          // Enregistrer la session dans la liste
          addSessionButton(msg.startTime || Date.now(), msg.filename);
        } else {
          // Stop — finaliser la session courante dans la liste
          finalizeCurrentSession(jState.j1.data, jState.j2.data);
          const infoEl2 = document.getElementById('jauge-save-info');
          if (infoEl2) { infoEl2.textContent = `✓ Session terminée`; infoEl2.style.color='var(--green)'; }
        }
        break;
      }

      case 'quad_live': {
        if (!qState.running) break;
        Object.assign(qState, {
          masses: msg.masses||[], signals: msg.signals||[],
          cycle: msg.cycle||0,
          prevMasses: msg.prevMasses||[], prevSignals: msg.prevSignals||[],
          tCycle: msg.tCycle||0, tTotal: msg.tTotal||0,
        });
        if (msg.startMass && msg.endMass) updateQuadAxisRange(msg.startMass, msg.endMass);
        scheduleQuadDraw();
        break;
      }

      case 'scan_done': {
        allScans.push({ cycle:msg.cycle, masses:msg.masses, signals:msg.signals });
        if (allScans.length > 50) allScans.shift();
        renderPills(allScans);
        break;
      }

      case 'jauge_live': {
        if (!jState.running) break;
        const ts = msg.ts || Date.now();
        if (msg.p1 != null) {
          document.getElementById('j-p1').textContent  = msg.p1.toFixed(8)
          document.getElementById('j-ts1').textContent = new Date(ts).toLocaleTimeString('fr-FR');
          jState.j1.data.push({ ts, value:msg.p1 });
          if (jState.j1.data.length > MAX_J_PTS) jState.j1.data.shift();
          if (jState.j1.slider >= 99) scheduleJaugeDraw('j1');
          refreshDSliders();
        }
        if (msg.p2 != null) {
          document.getElementById('j-p2').textContent  = msg.p2.toFixed(8)
          document.getElementById('j-ts2').textContent = new Date(ts).toLocaleTimeString('fr-FR');
          jState.j2.data.push({ ts, value:msg.p2 });
          if (jState.j2.data.length > MAX_J_PTS) jState.j2.data.shift();
          if (jState.j2.slider >= 99) scheduleJaugeDraw('j2');
        }
        break;
      }

      case 'device_status': {
        const devId = msg.device==='quad' ? 'quad' : msg.device==='laser' ? 'laser' : 'jauge';
        const pillEl = document.getElementById('pill-'+devId);
        if (pillEl) setPill(devId, msg.hw ? 'hw' : msg.demo ? 'demo' : 'err');
        break;
      }

      case 'jauge_error': {
        const infoErr = document.getElementById('jauge-save-info');
        if (infoErr) { infoErr.textContent = `⚠ ${msg.msg}`; infoErr.style.color = 'var(--amber)'; }
        console.warn('[JAUGE]', msg.msg);
        break;
      }

      case 'laser_status': {
        setLaserRunning(msg.running);
        updateLaserUI(msg);
        setPill('laser', msg.hw ? 'hw' : msg.demo ? 'demo' : 'err');
        if (!msg.running && msg.phase === 'done') {
          document.getElementById('laser-phase').textContent = '✓ Séquence terminée';
        }
        break;
      }

      case 'jauge_excel_ready': {
        const infoEl = document.getElementById('jauge-save-info');
        if (infoEl) {
          infoEl.textContent = `✓ Session terminée — CSV + Excel → DATA/${msg.filename}`;
          infoEl.style.color = 'var(--green)';
        }
        break;
      }

      case 'pong': {
        document.getElementById('hlatency').textContent = `${Date.now()-msg.t} ms`;
        break;
      }
    }
  };
}

document.addEventListener('DOMContentLoaded', () => {
  initQuadCharts();   // quad.js
  initJauge();        // jauge.js
  initDSliders();     // jauge.js
  applyViewerMode();  // ws.js
  connect();          // ws.js
});

// Boucles de rendu — démarrées après init pour que toutes les fonctions soient définies
setInterval(() => {
  try { if (_quadDirty) { _quadDirty = false; drawQuad(); } } catch(e) { console.warn('drawQuad error:', e); }
}, 200);
setInterval(() => {
  try { if (_jDirty.j1) { _jDirty.j1 = false; drawJauge('j1'); } } catch(e) { console.warn('drawJauge j1 error:', e); }
  try { if (_jDirty.j2) { _jDirty.j2 = false; drawJauge('j2'); } } catch(e) { console.warn('drawJauge j2 error:', e); }
}, 1000);
