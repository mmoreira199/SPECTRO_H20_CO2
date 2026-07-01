/**
 * LAB DASHBOARD SERVER v3
 * WebSocket + HTTP + Excel auto-save
 */
'use strict';

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const express   = require('express');
const WebSocket = require('ws');
const XLSX      = require('xlsx');

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  port: 3000,
  saveDir: path.join(__dirname, 'DATA'),   // dossier de sauvegarde

  quad: {
    enabled:   true,
    host:      '169.254.248.184',
    port:      10014,
    startMass: 3,
    endMass:   70,
    speed:     '1',
    nScans:    999,
    egains:    '0',
    FouM:      '0',
  },
  jauge: {
    enabled:         true,
    port1:           'COM3',
    port2:           'COM4',
    baud:            9600,
    autoSaveEvery:   500,   // lignes avant flush Excel (~25s à 20Hz)
  },
  laser: {
    port: 'COM7',
    baud: 19200,
  },
  demo: {
    quadIntervalMs:  80,
    jaugeIntervalMs: 250,
  }
};

// ─── Chargement config.json (écrase les valeurs par défaut) ────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // Merge profond sur les clés connues
    ['quad','jauge','laser','demo'].forEach(k => {
      if (saved[k]) Object.assign(CONFIG[k], saved[k]);
    });
    if (saved.saveDir) CONFIG.saveDir = saved.saveDir;
    console.log('[CONFIG] config.json chargé');
  } catch(e) { console.warn('[CONFIG] Erreur lecture config.json:', e.message); }
}

// Créer le dossier DATA si inexistant
if (!fs.existsSync(CONFIG.saveDir)) fs.mkdirSync(CONFIG.saveDir, { recursive: true });

// Formateur heure locale — format exact : 2026-06-10 08:43:12.492000
function toLocalISO(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad2 = n => String(n).padStart(2,'0');
  const pad6 = n => String(n).padStart(3,'0') + '000'; // ms → µs (3 chiffres + 3 zéros)
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad6(d.getMilliseconds())}`;
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}_${pad(d.getMonth()+1)}_${pad(d.getDate())}_${pad(d.getHours())}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ÉTAT GLOBAL
// ═══════════════════════════════════════════════════════════════════════════
const state = {
  quad: {
    running: false, saving: false,
    cycle: 0, masses: [], signals: [], times: [],
    prevMasses: [], prevSignals: [],
    tCycleStart: null, tTotalStart: null,
    // buffer Excel (rows_data comme le Python original)
    rows: [],
    filename: null,
  },
  jauge: {
    running: false,
    p1: null, p2: null, ts: null,
    history1: [], history2: [],
    pendingRows: [], rowsWritten: 0,
    filename: null,
  },
};
const MAX_HISTORY = 50000;

let quadInterval = null, jaugeInterval = null;
let quadSock = null, jaugePorts = [];

// ═══════════════════════════════════════════════════════════════════════════
//  EXCEL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

// QUAD — réécrit tout (petit fichier, une ligne par point de masse)
let _quadSaving = false;
function saveQuadExcel() {
  if (!state.quad.rows.length || !state.quad.filename) return;
  if (_quadSaving) return;
  _quadSaving = true;
  const rows = state.quad.rows.slice();
  const file = state.quad.filename;
  setImmediate(() => {
    try {
      const ws  = XLSX.utils.json_to_sheet(rows);
      const wb  = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'QUAD');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      fs.writeFile(file, buf, (err) => {
        _quadSaving = false;
        if (err) console.error('[QUAD] Erreur Excel:', err.message);
        else console.log(`[QUAD] Excel : ${rows.length} lignes → ${path.basename(file)}`);
      });
    } catch(e) { _quadSaving = false; console.error('[QUAD] Erreur Excel:', e.message); }
  });
}

// JAUGE — CSV append : O(1) peu importe la taille, s'ouvre dans Excel
function initJaugeCSV(file) {
  // sep=; indique à Excel français le séparateur dès l'ouverture
  fs.writeFileSync(file, 'sep=;\nTemps;Pression1;Pression2\n', 'utf8');
}

let _csvWriting = false;
let _csvQueue   = [];

function saveJaugeCSV() {
  const j = state.jauge;
  if (!j.pendingRows.length || !j.filename) return;

  // Déplacer les lignes en attente dans la queue
  _csvQueue.push(...j.pendingRows);
  j.pendingRows = [];

  if (_csvWriting) return; // l'écriture en cours va vider la queue
  _csvWriting = true;

  setImmediate(() => {
    const lines = _csvQueue.splice(0); // vider la queue
    const csv = lines.map(r => `${r.Temps};${r.Pression1};${r.Pression2}`).join('\n') + '\n';
    fs.appendFile(j.filename, csv, 'utf8', (err) => {
      _csvWriting = false;
      if (err) console.error('[JAUGE] Erreur CSV:', err.message);
      else console.log(`[JAUGE] CSV +${lines.length} lignes → ${path.basename(j.filename)}`);
      // Si de nouvelles lignes sont arrivées pendant l'écriture
      if (_csvQueue.length || j.pendingRows.length) saveJaugeCSV();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  HTTP
// ═══════════════════════════════════════════════════════════════════════════
const app = express();
app.use(express.static(__dirname, {
  // Évite qu'un navigateur (mobile surtout) garde en cache une vieille version
  // de index.html/ws.js/etc. après une mise à jour du serveur — source classique
  // de bugs fantômes ("ça marche pas comme avant alors que le code a changé").
  setHeaders: (res) => res.set('Cache-Control', 'no-cache, no-store, must-revalidate'),
}));
app.get('/quad.js',  (_req, res) => res.sendFile(path.join(__dirname, 'quad.js')));
app.get('/jauge.js', (_req, res) => res.sendFile(path.join(__dirname, 'jauge.js')));
app.get('/ws.js',    (_req, res) => res.sendFile(path.join(__dirname, 'ws.js')));
app.get('/config.html',             (_req, res) => res.sendFile(path.join(__dirname, 'config.html')));
app.get('/analyse_quad.html',       (_req, res) => res.sendFile(path.join(__dirname, 'analyse_quad.html')));
app.get('/pressure_annotator.html', (_req, res) => res.sendFile(path.join(__dirname, 'pressure_annotator.html')));
app.get('/co2_decroissance.html',   (_req, res) => res.sendFile(path.join(__dirname, 'co2_decroissance.html')));
app.get('/api/status', (_req, res) => res.json({
  quad:  { running: state.quad.running,  saving: state.quad.saving,  cycle: state.quad.cycle },
  jauge: { running: state.jauge.running, p1: state.jauge.p1, p2: state.jauge.p2 },
}));

// Journal des évènements laser, filtrable par plage horaire (ms epoch) — utilisé
// par le générateur de rapport pour reconstituer la timeline laser d'une session.
app.get('/api/laser-log', (req, res) => {
  const from = req.query.from ? parseInt(req.query.from) : 0;
  const to   = req.query.to   ? parseInt(req.query.to)   : Date.now();
  res.json(laserLog.filter(e => e.t >= from && e.t <= to));
});

// Liste des fichiers du dossier DATA (nom, date de modif, taille) — utilisé par
// le générateur de rapport pour retrouver les fichiers QUAD/JAUGE d'une session.
app.get('/api/data-files', (_req, res) => {
  fs.readdir(CONFIG.saveDir, (err, files) => {
    if (err) return res.json([]);
    const out = files
      .filter(f => /\.(csv|xlsx)$/i.test(f))
      .map(f => {
        let stat; try { stat = fs.statSync(path.join(CONFIG.saveDir, f)); } catch { return null; }
        return stat ? { name: f, mtime: stat.mtimeMs, size: stat.size } : null;
      })
      .filter(Boolean)
      .sort((a,b) => b.mtime - a.mtime);
    res.json(out);
  });
});

// Téléchargement d'un fichier du dossier DATA — lecture seule, sans danger
// même en mode "viewer" (aucune commande matérielle, juste un fichier statique).
// Protégé contre la traversée de chemin (../) en vérifiant le chemin résolu.
app.get('/api/data-files/download', (req, res) => {
  const name = path.basename(String(req.query.name || '')); // strip tout chemin
  if (!name || !/\.(csv|xlsx)$/i.test(name)) {
    return res.status(400).send('Nom de fichier invalide.');
  }
  const fullPath = path.resolve(CONFIG.saveDir, name);
  const saveDirResolved = path.resolve(CONFIG.saveDir);
  if (!fullPath.startsWith(saveDirResolved + path.sep) && fullPath !== saveDirResolved) {
    return res.status(400).send('Chemin invalide.');
  }
  fs.access(fullPath, fs.constants.R_OK, (err) => {
    if (err) return res.status(404).send('Fichier introuvable.');
    res.download(fullPath, name);
  });
});
const httpServer = http.createServer(app);

// ═══════════════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════════
const wss = new WebSocket.Server({ server: httpServer });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const isViewer = url.searchParams.get('viewer') === '1';
  ws.isViewer = isViewer;
  console.log(`[WS] +1 client${isViewer ? ' (lecture seule)' : ''} (total: ${wss.clients.size})`);
  ws.send(JSON.stringify({
    type: 'init',
    viewer: isViewer,
    quadRunning:  state.quad.running,
    quadSaving:   state.quad.saving,
    quadFilename: state.quad.filename ? path.basename(state.quad.filename) : null,
    jaugeRunning: state.jauge.running,
    laserState:   laserState,
    quadCfg: {
      startMass: CONFIG.quad.startMass, endMass: CONFIG.quad.endMass,
      speed: CONFIG.quad.speed, nScans: CONFIG.quad.nScans,
    },
    quad: {
      cycle: state.quad.cycle, masses: state.quad.masses, signals: state.quad.signals,
      prevMasses: state.quad.prevMasses, prevSignals: state.quad.prevSignals,
    },
    jauge: {
      p1: state.jauge.p1, p2: state.jauge.p2, ts: state.jauge.ts,
      history1: state.jauge.history1.slice(-500),
      history2: state.jauge.history2.slice(-500),
    },
  }));

  ws.on('close', () => console.log(`[WS] -1 client`));

  // Commandes qui modifient l'état du labo — interdites en mode lecture seule
  const MUTATING_CMDS = new Set([
    'quad_start','quad_stop','quad_save','jauge_start','jauge_stop',
    'laser_start','laser_stop',
  ]);

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (ws.isViewer && MUTATING_CMDS.has(m.cmd)) {
      console.log(`[WS] Commande "${m.cmd}" bloquée (client lecture seule)`);
      return;
    }
    switch (m.cmd) {
      case 'ping':        ws.send(JSON.stringify({ type:'pong', t:m.t })); break;
      case 'quad_start':  startQuad(m.cfg);  break;
      case 'quad_stop':   stopQuad();         break;
      case 'quad_save':   toggleQuadSave(m);  break;
      case 'jauge_start': startJauge(m);  break;
      case 'jauge_stop':  stopJauge();        break;
      case 'laser_start':
        if (!laserState.running) runLaser(m.programme, m.customPower);
        break;
      case 'laser_stop':
        stopLaser();
        break;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  QUAD — helpers
// ═══════════════════════════════════════════════════════════════════════════
function parseMassReadings(text) {
  const result = [];
  let k = text.indexOf('MassReading');
  while (k > -1) {
    const sub  = text.slice(k + 12);
    const eol  = sub.indexOf('\r\n');
    const line = eol > -1 ? sub.slice(0, eol) : sub;
    const sp   = line.indexOf(' ');
    if (sp > -1) {
      const masse  = parseFloat(line.slice(0, sp));
      const signal = parseFloat(line.slice(sp + 1)) * 1e-6;
      if (!isNaN(masse) && !isNaN(signal)) result.push({ masse, signal });
    }
    k = text.indexOf('MassReading', k + 12);
  }
  return result;
}

function onQuadPoints(points) {
  const cfg = CONFIG.quad;
  const q   = state.quad;
  if (!q.running) return;

  for (const { masse, signal } of points) {
    // Marqueur début de cycle
    if (Math.abs(masse - (cfg.startMass - 0.5)) < 0.05) {

      // Premier marqueur : démarrer le cycle 1
      if (!q.tTotalStart) {
        q.tTotalStart = Date.now();
        q.tCycleStart = Date.now();
        continue;
      }

      // Fin du cycle en cours → sauvegarder et passer au suivant
      if (q.masses.length > 0) {
        q.prevMasses  = q.masses.slice();
        q.prevSignals = q.signals.slice();
        const prevTimes = q.times.slice(); // timestamps par point

        const tCycle = q.tCycleStart ? (Date.now() - q.tCycleStart) / 1000 : 0;
        const tTotal = (Date.now() - q.tTotalStart) / 1000;

        if (q.saving) {
          q.prevMasses.forEach((m, i) => {
            // Temps précis pour chaque point
            const tScan = q.tCycleStart ? (prevTimes[i] - q.tCycleStart) / 1000 : 0;
            const tTot  = (prevTimes[i] - q.tTotalStart) / 1000;
            q.rows.push({
              Cycle:            q.cycle,
              Masse:            m,
              Signal:           q.prevSignals[i],
              'Temps_scan(s)':  parseFloat(tScan.toFixed(3)),
              'Temps_total(s)': parseFloat(tTot.toFixed(3)),
            });
          });
          saveQuadExcel();
        }

        broadcast('scan_done', {
          cycle: q.cycle, masses: q.prevMasses, signals: q.prevSignals,
          tCycle, tTotal,
        });

        q.cycle++;
        broadcast('quad_info', { cycle: q.cycle });
      }

      q.masses = []; q.signals = []; q.times = [];
      q.tCycleStart = Date.now();
      continue;
    }
    if (masse >= 0) {
      q.masses.push(masse);
      q.signals.push(signal);
      q.times.push(Date.now()); // timestamp précis à la réception du point
    }
  }

  broadcast('quad_live', {
    cycle: q.cycle, masses: q.masses, signals: q.signals,
    prevMasses: q.prevMasses, prevSignals: q.prevSignals,
    tCycle: q.tCycleStart ? (Date.now() - q.tCycleStart) / 1000 : 0,
    tTotal: q.tTotalStart ? (Date.now() - q.tTotalStart) / 1000 : 0,
    startMass: cfg.startMass, endMass: cfg.endMass,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  QUAD — start / stop / save
// ═══════════════════════════════════════════════════════════════════════════
function startQuad(cfg) {
  if (state.quad.running) return;

  // Mettre à jour la config depuis le client (vitesse, masses, nScans)
  if (cfg) {
    if (cfg.startMass != null) CONFIG.quad.startMass = parseFloat(cfg.startMass);
    if (cfg.endMass   != null) CONFIG.quad.endMass   = parseFloat(cfg.endMass);
    if (cfg.speed     != null) CONFIG.quad.speed     = String(cfg.speed);
    if (cfg.nScans    != null) CONFIG.quad.nScans    = parseInt(cfg.nScans);
  }

  state.quad.running = true; state.quad.saving = false;
  state.quad.cycle = 1; state.quad.masses = []; state.quad.signals = []; state.quad.times = [];
  state.quad.prevMasses = []; state.quad.prevSignals = [];
  state.quad.tTotalStart = null; state.quad.tCycleStart = null;
  state.quad.rows = []; state.quad.filename = null;

  broadcast('quad_status', { running: true, saving: false,
    cfg: { startMass: CONFIG.quad.startMass, endMass: CONFIG.quad.endMass,
           speed: CONFIG.quad.speed, nScans: CONFIG.quad.nScans } });
  console.log(`[QUAD] Démarrage — m/z ${CONFIG.quad.startMass}-${CONFIG.quad.endMass} vitesse=${CONFIG.quad.speed} nScans=${CONFIG.quad.nScans}`);

  if (CONFIG.quad.enabled) startQuadTCP(); else startQuadDemo();
}

function stopQuad() {
  if (!state.quad.running) return;
  state.quad.running = false;
  // Flush Excel si des données en attente
  if (state.quad.saving && state.quad.rows.length) saveQuadExcel();
  state.quad.saving = false;
  broadcast('quad_status', { running: false, saving: false });
  console.log('[QUAD] Arrêt.');
  if (quadInterval) { clearInterval(quadInterval); quadInterval = null; }
  if (quadSock && !quadSock.destroyed) {
    try { quadSock.write('ScanStop\r\n'); quadSock.write('Release\r\n'); } catch {}
    quadSock.destroy(); quadSock = null;
  }
}

function toggleQuadSave(cfg) {
  const q = state.quad;
  if (!q.running) return;
  q.saving = !q.saving;
  if (q.saving) {
    q.rows = [];
    // Construire le nom de fichier avec prefix/suffix
    const pre = cfg?.prefix ? cfg.prefix.replace(/[^a-zA-Z0-9_-]/g,'') + '_' : '';
    const suf = cfg?.suffix ? '_' + cfg.suffix.replace(/[^a-zA-Z0-9_-]/g,'') : '';
    const fname = `${pre}SCAN_${timestamp()}${suf}.xlsx`;
    q.filename = path.join(CONFIG.saveDir, fname);
    console.log(`[QUAD] Sauvegarde activée → ${path.basename(q.filename)}`);
  } else {
    if (q.rows.length) saveQuadExcel();
    console.log('[QUAD] Sauvegarde désactivée.');
  }
  broadcast('quad_status', { running: q.running, saving: q.saving,
    filename: q.saving && q.filename ? path.basename(q.filename) : undefined });
}

function startQuadTCP() {
  const net = require('net');
  let buf = '', connected = false;
  function send(cmd) { if (quadSock && !quadSock.destroyed) quadSock.write(cmd + '\r\n'); }
  function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

  async function initAndScan() {
    send('Control Python 1.0');   await sleep(500);
    send('AcceptProtocol 1.6');   await sleep(500);
    send('FilamentControl On');   await sleep(2000);
    send('FilamentSelect 2');     await sleep(2000);
    send('FilamentOnTime 43200'); await sleep(200);
    const c = CONFIG.quad;
    send(`AddAnalog Analog2 ${c.startMass} ${c.endMass} 32 ${c.speed} ${c.egains} 0 ${c.FouM}`);
    await sleep(200);
    send('ScanAdd Analog2');      await sleep(200);
    send(`ScanStart ${c.nScans}`);await sleep(200);
    console.log('[QUAD] Scan TCP démarré');
  }

  quadSock = new (require('net').Socket)();
  quadSock.setTimeout(5000);
  quadSock.connect(CONFIG.quad.port, CONFIG.quad.host, () => {
    connected = true;
    broadcast('device_status', { device:'quad', hw:true });
    initAndScan();
  });
  quadSock.on('data', (chunk) => {
    buf += chunk.toString('ascii');
    const pts = parseMassReadings(buf);
    if (pts.length) {
      onQuadPoints(pts);
      const last = buf.lastIndexOf('MassReading');
      buf = last > -1 ? buf.slice(last) : '';
      if (buf.length > 100000) buf = '';
    }
  });
  quadSock.on('error', (e) => {
    console.error('[QUAD] Erreur TCP:', e.message);
    if (!connected) { broadcast('device_status',{device:'quad',hw:false,demo:true}); startQuadDemo(); }
  });
  quadSock.on('close', () => {
    if (!connected) { startQuadDemo(); return; }
    if (state.quad.running) { console.log('[QUAD] Reconnexion 3s...'); setTimeout(startQuadTCP, 3000); }
  });
  quadSock.on('timeout', () => { quadSock.destroy(); });
}

function startQuadDemo() {
  const cfg = CONFIG.quad;
  const masses = [];
  for (let m = cfg.startMass; m <= cfg.endMass; m += 0.25)
    masses.push(Math.round(m * 100) / 100);
  const peaks = { 2:1e-7,14:3e-8,18:5e-7,28:8e-7,32:2e-7,40:6e-8,44:1e-7 };
  let idx = 0;
  broadcast('device_status', { device:'quad', hw:false, demo:true });
  console.log('[DEMO] QUAD simulation active');

  quadInterval = setInterval(() => {
    if (!state.quad.running) { clearInterval(quadInterval); quadInterval = null; return; }
    const points = [];
    for (let b = 0; b < 20; b++) {
      if (idx === 0) points.push({ masse: cfg.startMass - 0.5, signal: 0 });
      const masse = masses[idx];
      let signal = 1e-10 * (1 + Math.random() * 0.5);
      if (peaks[Math.round(masse)]) signal += peaks[Math.round(masse)] * (1 + (Math.random()-0.5)*0.2);
      points.push({ masse, signal });
      idx = (idx + 1) % masses.length;
    }
    onQuadPoints(points);
  }, CONFIG.demo.quadIntervalMs);
}

// ═══════════════════════════════════════════════════════════════════════════
//  JAUGE — start / stop
// ═══════════════════════════════════════════════════════════════════════════
function startJauge(cfg) {
  if (state.jauge.running) return;
  state.jauge.running = true;
  state.jauge.history1 = []; state.jauge.history2 = [];
  state.jauge.p1 = null; state.jauge.p2 = null;
  state.jauge.pendingRows = []; state.jauge.rowsWritten = 0;
  _csvQueue = [];

  // Construire le nom de fichier avec prefix/suffix
  const pre = cfg?.prefix ? cfg.prefix.replace(/[^a-zA-Z0-9_-]/g,'') + '_' : '';
  const suf = cfg?.suffix ? '_' + cfg.suffix.replace(/[^a-zA-Z0-9_-]/g,'') : '';
  const fname = `${pre}JAUGE_${timestamp()}${suf}.csv`;
  state.jauge.filename = path.join(CONFIG.saveDir, fname);
  initJaugeCSV(state.jauge.filename);
  broadcast('jauge_status', { running: true, filename: path.basename(state.jauge.filename), startTime: Date.now() });
  console.log(`[JAUGE] Démarrage — sauvegarde auto → ${path.basename(state.jauge.filename)}`);
  if (CONFIG.jauge.enabled) startJaugeSerie(); else startJaugeDemo();
}

function stopJauge() {
  if (!state.jauge.running) return;
  state.jauge.running = false;
  if (state.jauge.pendingRows.length) saveJaugeCSV();
  broadcast('jauge_status', { running: false });
  console.log('[JAUGE] Arrêt + flush final.');
  if (jaugeInterval) { clearInterval(jaugeInterval); jaugeInterval = null; }
  jaugePorts.forEach(sp => { try { sp.close(); } catch {} });
  jaugePorts = [];

  // Convertir le CSV en Excel après un court délai (laisser le flush CSV terminer)
  if (state.jauge.filename) {
    const csvFile = state.jauge.filename;
    setTimeout(() => convertJaugeCsvToExcel(csvFile), 800);
  }
}

function convertJaugeCsvToExcel(csvFile) {
  if (!csvFile || !require('fs').existsSync(csvFile)) return;
  try {
    const xlsxFile = csvFile.replace(/\.csv$/, '.xlsx');
    const content  = require('fs').readFileSync(csvFile, 'utf8');
    // Parser le CSV (séparateur ;)
    const lines = content.trim().split('\n').filter(l => l.trim() && !l.startsWith('sep='));
    if (lines.length < 2) return;
    const headers = lines[0].split(';');
    const rows = lines.slice(1).map(l => {
      const vals = l.split(';');
      const obj = {};
      headers.forEach((h, i) => {
        const v = vals[i]?.trim() ?? '';
        obj[h.trim()] = isNaN(v) || v === '' ? v : parseFloat(v);
      });
      return obj;
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pressions');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    require('fs').writeFile(xlsxFile, buf, (err) => {
      if (err) console.error('[JAUGE] Erreur conversion Excel:', err.message);
      else {
        console.log(`[JAUGE] Excel généré : ${path.basename(xlsxFile)}`);
        broadcast('jauge_excel_ready', { filename: path.basename(xlsxFile) });
      }
    });
  } catch(e) {
    console.error('[JAUGE] Erreur conversion CSV→Excel:', e.message);
  }
}

const MAX_ROWS_PER_FILE = 10000; // non utilisé en CSV mais gardé pour référence

function pushP1(value, ts) {
  const j = state.jauge;
  if (!j.running) return;
  j.p1 = value; j.ts = ts;
  j.history1.push({ ts, value });
  if (j.history1.length > MAX_HISTORY) j.history1.shift();
  scheduleJaugeBroadcast();
}

function pushP2(value, ts) {
  const j = state.jauge;
  if (!j.running) return;
  j.p2 = value; j.ts = ts;
  j.history2.push({ ts, value });
  if (j.history2.length > MAX_HISTORY) j.history2.shift();
  scheduleJaugeBroadcast();
}

function pushJaugePoint(p1, p2, ts) {
  // Pour la démo qui envoie les deux en même temps
  if (p1 != null) pushP1(p1, ts);
  if (p2 != null) pushP2(p2, ts);
  // CSV — une ligne par paire complète
  const j = state.jauge;
  j.pendingRows.push({
    Temps:     toLocalISO(new Date(ts)),
    Pression1: (j.p1 ?? 0).toFixed(10),
    Pression2: (j.p2 ?? 0).toFixed(10),
  });
  if (j.pendingRows.length >= CONFIG.jauge.autoSaveEvery) saveJaugeCSV();
}

let _jBcastTimer = null;
function scheduleJaugeBroadcast() {
  if (_jBcastTimer) return;
  _jBcastTimer = setTimeout(() => {
    _jBcastTimer = null;
    const j = state.jauge;
    if (j.p1 !== null || j.p2 !== null)
      broadcast('jauge_live', { p1: j.p1, p2: j.p2, ts: j.ts });
  }, 250);
}

// Pour le mode série : ajoute une ligne CSV avec les dernières valeurs connues
let _csvRowTimer = null;
function appendJaugeCSVRow() {
  if (_csvRowTimer) return;
  _csvRowTimer = setTimeout(() => {
    _csvRowTimer = null;
    const j = state.jauge;
    if (!j.running || !j.filename) return;
    j.pendingRows.push({
      Temps:     toLocalISO(new Date(j.ts)),
      Pression1: (j.p1 ?? 0).toFixed(10),
      Pression2: (j.p2 ?? 0).toFixed(10),
    });
    if (j.pendingRows.length >= CONFIG.jauge.autoSaveEvery) saveJaugeCSV();
  }, 50); // grouper les deux ports sur 50ms
}

function startJaugeSerie() {
  let SerialPort;
  try { SerialPort = require('serialport').SerialPort; }
  catch {
    const msg = '[JAUGE] Module serialport non installé → npm install serialport';
    console.warn(msg);
    broadcast('jauge_error', { msg: 'serialport non installé — mode simulation activé' });
    startJaugeDemo(); return;
  }

  function checksum(data) { return data.slice(0,7).reduce((a,b)=>a+b,0) & 0xFF; }

  let openCount = 0;

  function openPort(comPort, label, onValue) {
    const sp = new SerialPort({ path:comPort, baudRate:CONFIG.jauge.baud, autoOpen:false });
    let frameBuf = Buffer.alloc(0);
    sp.open((err) => {
      if (err) {
        console.error(`[JAUGE] ${label} impossible d'ouvrir ${comPort}: ${err.message}`);
        broadcast('jauge_error', { msg: `${comPort} inaccessible: ${err.message}` });
        openCount++;
        if (jaugePorts.length === 0 && openCount >= 2) { console.warn('[JAUGE] Aucun port → simulation'); startJaugeDemo(); }
        return;
      }
      openCount++;
      jaugePorts.push(sp);
      broadcast('device_status', { device:`jauge_${label}`, hw:true });
    });
    sp.on('data', (chunk) => {
      if (!state.jauge.running) return;
      frameBuf = Buffer.concat([frameBuf, chunk]);
      while (frameBuf.length >= 9) {
        const idx = frameBuf.indexOf(0x07);
        if (idx === -1) { frameBuf = Buffer.alloc(0); break; }
        if (idx > 0)    { frameBuf = frameBuf.slice(idx); continue; }
        if (frameBuf.length < 9) break;
        const data = frameBuf.slice(1,9); frameBuf = frameBuf.slice(9);
        if (checksum(data.slice(0,7)) !== data[7]) continue;
        const raw = (data[3]<<8)|data[4];
        onValue((raw/32000)*1.3332);
      }
    });
    sp.on('error', e => console.error(`[JAUGE] ${label} erreur:`, e.message));
  }

  // Chaque port push indépendamment
  openPort(CONFIG.jauge.port1, 'P1', v => {
    pushP1(v, Date.now());
    appendJaugeCSVRow();
  });
  openPort(CONFIG.jauge.port2, 'P2', v => {
    pushP2(v, Date.now());
    appendJaugeCSVRow();
  });

  setTimeout(() => { if (jaugePorts.length === 0) { console.warn('[JAUGE] Aucun port → simulation'); startJaugeDemo(); } }, 2000);
}

function startJaugeDemo() {
  let p1 = 1.2e-5, p2 = 3.4e-6;
  broadcast('device_status', { device:'jauge', hw:false, demo:true });
  console.log('[DEMO] Jauge simulation active');
  jaugeInterval = setInterval(() => {
    if (!state.jauge.running) { clearInterval(jaugeInterval); jaugeInterval = null; return; }
    p1 *= 1+(Math.random()-0.5)*0.02; p2 *= 1+(Math.random()-0.5)*0.02;
    p1 = Math.max(1e-8,Math.min(1e-3,p1)); p2 = Math.max(1e-9,Math.min(1e-4,p2));
    pushJaugePoint(p1, p2, Date.now());
  }, CONFIG.demo.jaugeIntervalMs);
}

// ═══════════════════════════════════════════════════════════════════════════
//  LASER — état global
// ═══════════════════════════════════════════════════════════════════════════
const laserState = {
  running:   false,
  programme: null,   // 'siderite' | 'chondrite'
  phase:     null,   // 'heating' | 'palier_5000' | ... | 'done'
  power:     0,      // puissance IC2 courante
  targetPower: 0,
  progress:  0,      // 0-100 %
  message:   '',
  startTime: null,
  elapsed:   0,
};

let laserSerPort  = null;
let laserAbort    = false;
let laserDemoMode = false;

// Journal des évènements laser (pour le générateur de rapport) — en mémoire,
// limité aux 1000 dernières entrées. Format : {t, type:'start'|'stop', programme, customPower}
const laserLog = [];
function logLaserEvent(entry) {
  laserLog.push({ t: Date.now(), ...entry });
  if (laserLog.length > 1000) laserLog.shift();
}

function broadcastLaser() {
  broadcast('laser_status', { ...laserState });
}

// ── Séquences ─────────────────────────────────────────────────────────────

// heating_up(max=4000, duree=10s, duree2=30s)
// paliers chondrite : 5000/6000/7000/8000/9000 × 30s chacun

const SIDERITE_STEPS = (() => {
  const steps = [];
  for (let p = 0; p <= 4000; p += 100) steps.push({ power: p, hold: 10, label: `Montée ${p} mA` });
  steps.push({ power: 4000, hold: 30, label: 'Palier 4000 mA' });
  steps.push({ power: 0,    hold: 0,  label: 'Arrêt', stop: true });
  return steps;
})();

const CHONDRITE_STEPS = (() => {
  const steps = [];
  for (let p = 0; p <= 4000; p += 100) steps.push({ power: p, hold: 10, label: `Montée ${p} mA` });
  steps.push({ power: 4000, hold: 30, label: 'Palier 4000 mA' });
  [5000,6000,7000,8000,9000].forEach(p =>
    steps.push({ power: p, hold: 30, label: `Palier ${p} mA` })
  );
  steps.push({ power: 0, hold: 0, label: 'Arrêt', stop: true });
  return steps;
})();

// ── Comm série ─────────────────────────────────────────────────────────────
function laserSend(ser, cmd) {
  return new Promise((resolve, reject) => {
    const line = cmd + '\r';
    let resp = '';
    const onData = (data) => {
      resp += data.toString('utf8');
      if (resp.includes('\n') || resp.includes('\r')) {
        ser.removeListener('data', onData);
        resolve(resp.replace(/[\r\n]/g, '').trim());
      }
    };
    ser.on('data', onData);
    ser.write(line, (err) => { if (err) { ser.removeListener('data', onData); reject(err); } });
    setTimeout(() => { ser.removeListener('data', onData); resolve(''); }, 1000);
  });
}

async function runLaser(programme, customPower) {
  laserAbort = false;

  // Construire les steps selon le programme
  let steps;
  if (programme === 'custom') {
    const maxP = Math.max(100, Math.min(10000, customPower || 5000));
    steps = [];
    for (let p = 0; p <= maxP; p += 100)
      steps.push({ power: p, hold: 10, label: `Montée ${p} mA` });
    steps.push({ power: maxP, hold: 30, label: `Palier ${maxP} mA` });
    steps.push({ power: 0, hold: 0, label: 'Arrêt', stop: true });
  } else {
    steps = programme === 'chondrite' ? CHONDRITE_STEPS : SIDERITE_STEPS;
  }
  const totalSteps = steps.length;

  laserState.running   = true;
  laserState.programme = programme;
  laserState.startTime = Date.now();
  laserState.phase     = 'init';
  laserState.power     = 0;
  laserState.progress  = 0;
  logLaserEvent({ type:'start', programme, customPower: customPower||null });
  broadcastLaser();

  // Ouvrir ou simuler le port série
  let ser = null;
  try {
    const { SerialPort } = require('serialport');
    ser = new SerialPort({ path: CONFIG.laser.port, baudRate: CONFIG.laser.baud, autoOpen: false });
    await new Promise((res, rej) => ser.open(e => e ? rej(e) : res()));
    laserDemoMode = false;
    console.log(`[LASER] Port ${CONFIG.laser.port} ouvert`);
    broadcast('device_status', { device:'laser', hw:true });
  } catch(e) {
    console.warn('[LASER] Port indisponible → simulation:', e.message);
    laserDemoMode = true;
    broadcast('device_status', { device:'laser', hw:false, demo:true });
  }

  const sendCmd = async (cmd) => {
    if (laserDemoMode) { console.log(`[LASER DEMO] ${cmd}`); return cmd; }
    return laserSend(ser, cmd);
  };

  try {
    // Puissance à 0 + allumage
    await sendCmd('IC2=0');
    await sleep(1000);
    await sendCmd('ASS=1');

    for (let i = 0; i < steps.length; i++) {
      if (laserAbort) break;
      const step = steps[i];

      if (step.stop) {
        await sendCmd('ASS=0');
        laserState.phase   = 'done';
        laserState.power   = 0;
        laserState.progress = 100;
        laserState.message = 'Séquence terminée';
        broadcastLaser();
        break;
      }

      await sendCmd(`IC2=${step.power}`);
      laserState.power      = step.power;
      laserState.targetPower = step.power;
      laserState.phase      = step.label;
      laserState.progress   = Math.round((i / (totalSteps - 2)) * 100);
      laserState.elapsed    = (Date.now() - laserState.startTime) / 1000;
      laserState.message    = step.label;
      broadcastLaser();
      console.log(`[LASER] ${step.label} — ${step.power} mA`);

      if (step.hold > 0) await sleepAbortable(step.hold * 1000);
    }
  } catch(e) {
    console.error('[LASER] Erreur:', e.message);
    laserState.message = 'Erreur: ' + e.message;
  }

  // Nettoyage
  if (!laserDemoMode && ser) {
    try { await sendCmd('ASS=0'); } catch {}
    ser.close();
  }
  laserState.running = false;
  if (!laserAbort) laserState.phase = 'done';
  logLaserEvent({ type:'stop', programme, aborted: laserAbort,
    durationS: laserState.startTime ? (Date.now()-laserState.startTime)/1000 : null });
  broadcastLaser();
  console.log('[LASER] Séquence terminée');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sleepAbortable(ms) {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (laserAbort) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, ms);
  });
}

async function stopLaser() {
  laserAbort = true;
  laserState.message = 'Arrêt demandé...';
  broadcastLaser();
  // Le port est fermé dans runLaser après détection laserAbort
}

// ─── API CONFIG ─────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    saveDir:  CONFIG.saveDir,
    quad:     { ...CONFIG.quad },
    jauge:    { ...CONFIG.jauge },
    laser:    { ...CONFIG.laser },
    demo:     { ...CONFIG.demo },
  });
});

app.post('/api/config', express.json(), (req, res) => {
  const c = req.body;
  if (!c) return res.status(400).json({ error: 'Corps vide' });

  try {
    // Appliquer les valeurs reçues
    if (c.saveDir) CONFIG.saveDir = path.normalize(c.saveDir);
    if (c.quad)  Object.assign(CONFIG.quad,  c.quad);
    if (c.jauge) Object.assign(CONFIG.jauge, c.jauge);
    if (c.laser) Object.assign(CONFIG.laser, c.laser);
    if (c.demo)  Object.assign(CONFIG.demo,  c.demo);

    // Créer le dossier si changé
    try {
      if (!fs.existsSync(CONFIG.saveDir))
        fs.mkdirSync(CONFIG.saveDir, { recursive: true });
    } catch(dirErr) {
      console.warn('[CONFIG] Impossible de créer le dossier:', CONFIG.saveDir, dirErr.message);
    }

    // Sauvegarder dans config.json
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      saveDir: CONFIG.saveDir,
      quad:    CONFIG.quad,
      jauge:   CONFIG.jauge,
      laser:   CONFIG.laser,
      demo:    CONFIG.demo,
    }, null, 2), 'utf8');
    console.log('[CONFIG] Sauvegardé — saveDir:', CONFIG.saveDir);
    res.json({ ok: true });
  } catch(e) {
    console.error('[CONFIG] Erreur sauvegarde:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ═══════════════════════════════════════════════════════════════════════════
const { spawn } = require('child_process');

const SCRIPTS = {
  analyse_quad: {
    file:  path.join(__dirname, 'scripts', 'analyse_quad.py'),
    title: 'Analyseur de Signal Log₁₀',
    desc:  'Charge un fichier Excel QUAD, trace le signal log₁₀ par cycle, soustraction de cycles, export PNG/Excel.',
    deps:  'pandas numpy matplotlib openpyxl',
  },
  pressure_annotator: {
    file:  path.join(__dirname, 'scripts', 'pressure_annotator.py'),
    title: 'Pressure Annotator',
    desc:  'Annote les courbes de pression (CSV/Excel) avec des étiquettes glissées-déposées : laser on, pumping, N₂ liq…',
    deps:  'pandas matplotlib openpyxl',
  },
  co2_decroissance: {
    file:  path.join(__dirname, 'scripts', 'co2_decroissance.py'),
    title: 'Analyse décroissance CO₂',
    desc:  'Fit exponentiel de la décroissance du CO₂ (masse 44) — deux méthodes : aire sous courbe et pic max. Export CSV + PNG.',
    deps:  'pandas numpy matplotlib scipy openpyxl',
  },
};

const runningProcesses = {};

app.post('/api/scripts/launch', express.json(), (req, res) => {
  const { id } = req.body;
  const script = SCRIPTS[id];
  if (!script) return res.status(404).json({ error: 'Script inconnu' });

  // Tuer le processus existant si déjà lancé
  if (runningProcesses[id]) {
    try { runningProcesses[id].kill(); } catch {}
    delete runningProcesses[id];
  }

  const proc = spawn('python', [script.file], {
    detached: true,   // fenêtre Tkinter indépendante
    stdio:    'ignore',
  });
  proc.unref(); // ne pas bloquer le serveur
  runningProcesses[id] = proc;

  proc.on('exit', () => {
    delete runningProcesses[id];
    broadcast('script_exit', { id });
  });
  proc.on('error', (e) => {
    delete runningProcesses[id];
    broadcast('script_exit', { id, error: e.message });
  });

  broadcast('script_started', { id });
  res.json({ ok: true, pid: proc.pid });
});

app.post('/api/scripts/stop', express.json(), (req, res) => {
  const { id } = req.body;
  if (runningProcesses[id]) {
    try { runningProcesses[id].kill(); } catch {}
    delete runningProcesses[id];
  }
  res.json({ ok: true });
});

app.get('/api/scripts/status', (_req, res) => {
  const status = {};
  Object.keys(SCRIPTS).forEach(id => { status[id] = !!runningProcesses[id]; });
  res.json(status);
});
httpServer.listen(CONFIG.port, () => {
  console.log(`\n🔬 Lab Dashboard — http://localhost:${CONFIG.port}`);
  console.log(`   QUAD  : ${CONFIG.quad.enabled ? `TCP ${CONFIG.quad.host}:${CONFIG.quad.port}` : 'simulation'}`);
  console.log(`   Jauge : ${CONFIG.jauge.enabled ? `${CONFIG.jauge.port1}/${CONFIG.jauge.port2}` : 'simulation'}`);
  console.log(`   DATA  : ${CONFIG.saveDir}\n`);
});
