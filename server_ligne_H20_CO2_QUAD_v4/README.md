# Lab Dashboard — QUAD MKS + Jauge Inficon

Dashboard temps réel via **WebSocket** pour remplacer le polling SSE/REST.

## Démarrage

```bash
npm install
node server.js
# → http://localhost:3000
```

## Configuration (server.js — section CONFIG)

```js
const CONFIG = {
  port: 3000,

  quad: {
    enabled: true,              // false = simulation
    host: '169.254.248.184',    // IP du QUAD MKS
    port: 10014,
    startMass: 3,
    endMass:   70,
    speed: '1',
    nScans: 999,
    egains: '0',
    FouM: '0',                  // '0'=Faraday, '1'=Multiplier
  },

  jauge: {
    enabled: true,              // false = simulation
    port1: 'COM3',
    port2: 'COM4',
    baud:   9600,
  },
}
```

## Mode démo (sans matériel)

Mettre `enabled: false` pour chaque appareil → des données réalistes
sont générées automatiquement. Pratique pour tester l'interface.

## Architecture

```
server.js
  ├─ HTTP (Express)     → sert index.html
  ├─ WebSocket (ws)     → pousse données en temps réel
  ├─ TCP socket         → QUAD MKS parser MassReading
  └─ serialport         → Jauge Inficon (COM3/COM4)

index.html
  ├─ Chart.js + zoom    → graphes linéaire / log / historique
  ├─ WebSocket client   → réception et rendu rAF-throttled
  └─ Même style que dashboard_v2.html
```

## Dépendances

| Package      | Usage                          |
|-------------|-------------------------------|
| express      | HTTP + fichiers statiques      |
| ws           | WebSocket serveur              |
| serialport   | Port série (npm install serialport) |

> `serialport` est optionnel : si absent, la jauge passe automatiquement en mode démo.

## Comparaison avec dashboard_v2.html

| Avant (SSE + REST)          | Après (WebSocket)              |
|-----------------------------|--------------------------------|
| SSE push + fetch séparé     | Un seul message WS             |
| Polling REST jauge 2s       | Push immédiat à 20 Hz          |
| Reconnexion manuelle SSE    | Auto-reconnexion WS built-in   |
| Latence ~100-500ms          | Latence <10ms local            |
