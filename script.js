'use strict';
(() => {

/* ============================================================
   MOTOR DO JOGO (sem DOM): pista, física, bots e classificação
   ============================================================ */
const W = 640, H = 400;

const COLORS = [
  { name: 'Ciano',    c: '#19e3ff', d: '#0b8da3' },
  { name: 'Magenta',  c: '#ff3df2', d: '#a31e9a' },
  { name: 'Limão',    c: '#b6ff3b', d: '#6e9e1a' },
  { name: 'Âmbar',    c: '#ffb02e', d: '#a36a10' },
  { name: 'Vermelho', c: '#ff4d5e', d: '#a02633' },
  { name: 'Violeta',  c: '#9b6bff', d: '#5c3bb3' },
  { name: 'Azul',     c: '#3d7bff', d: '#1f4aa8' },
  { name: 'Branco',   c: '#eaf6ff', d: '#8ea6c0' }
];

// Pontos de controle da pista (curva fechada, sentido horário na tela)
const CTRL = [
  [100,120],[200,60],[330,70],[420,120],[520,70],[590,130],[580,250],
  [510,320],[400,340],[330,290],[250,330],[140,335],[70,270],[70,190]
];
const HW = 22;    // meia largura do asfalto
const WALL = 46;  // distância da barreira até o centro da pista
const PER = 24;   // amostras por trecho

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const wrapAngle = a => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

// Linha central da pista (spline Catmull-Rom fechada)
const track = [];
(function buildCenterline() {
  const n = CTRL.length;
  for (let i = 0; i < n; i++) {
    const p0 = CTRL[(i - 1 + n) % n], p1 = CTRL[i], p2 = CTRL[(i + 1) % n], p3 = CTRL[(i + 2) % n];
    for (let j = 0; j < PER; j++) {
      const t = j / PER, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      track.push({ x: f(p0[0], p1[0], p2[0], p3[0]), y: f(p0[1], p1[1], p2[1], p3[1]) });
    }
  }
  const m = track.length;
  for (let i = 0; i < m; i++) {
    const a = track[(i - 1 + m) % m], b = track[(i + 1) % m];
    let tx = b.x - a.x, ty = b.y - a.y;
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    Object.assign(track[i], { tx, ty, nx: -ty, ny: tx, ang: Math.atan2(ty, tx) });
  }
})();
const N = track.length;
const START = 40; // índice da linha de largada

// Constantes de física
const ACC = 150, BRAKE = 230, MAXV = 112, MAXREV = 38, TURN = 2.7;

function makeCar(slot, name, human, k) {
  const row = k >> 1, col = k & 1;
  const raw = START - 5 - row * 4 - (col ? 2 : 0);
  const idx = (raw + N) % N;
  const p = track[idx];
  const off = col ? 9 : -9;
  return {
    slot, name, human,
    x: p.x + p.nx * off, y: p.y + p.ny * off, a: p.ang, vx: 0, vy: 0,
    idx, prog: raw - START, d: 0,
    input: { up: false, down: false, left: false, right: false },
    canDrive: false, auto: false,
    sf: human ? 1 : 0.88 + Math.random() * 0.1,
    lane: (Math.random() * 2 - 1) * 9,
    finished: false, finishTime: 0, reverseT: 0, stuckT: 0,
    dx: 0, dy: 0, da: 0, tx: 0, ty: 0, ta: 0, pdx: 0, pdy: 0, spd: 0
  };
}

function nearestIdx(x, y) {
  let b = 0, bd = 1e12;
  for (let i = 0; i < N; i++) {
    const p = track[i];
    const d = (x - p.x) * (x - p.x) + (y - p.y) * (y - p.y);
    if (d < bd) { bd = d; b = i; }
  }
  return b;
}

// Acompanha o carro na pista: atualiza índice, progresso total e distância ao centro
function updateTrack(c) {
  let best = c.idx, bd = 1e12;
  for (let k = -14; k <= 14; k++) {
    const i = (c.idx + k + N) % N;
    const p = track[i];
    const d = (c.x - p.x) * (c.x - p.x) + (c.y - p.y) * (c.y - p.y);
    if (d < bd) { bd = d; best = i; }
  }
  let delta = best - c.idx;
  if (delta > N / 2) delta -= N; else if (delta < -N / 2) delta += N;
  c.prog += delta;
  c.idx = best;
  c.d = Math.sqrt(bd);
}

// Barreira de energia ao redor da pista
function constrain(c) {
  const p = track[c.idx];
  const dx = c.x - p.x, dy = c.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d > WALL) {
    const ox = dx / d, oy = dy / d;
    c.x = p.x + ox * WALL;
    c.y = p.y + oy * WALL;
    const vn = c.vx * ox + c.vy * oy;
    if (vn > 0) {
      c.vx -= ox * vn * 1.6; c.vy -= oy * vn * 1.6;
      c.vx *= 0.9; c.vy *= 0.9;
    }
    c.d = WALL;
  }
}

function stepCar(c, dt) {
  const inp = c.input;
  const fx = Math.cos(c.a), fy = Math.sin(c.a), px = -fy, py = fx;
  let vf = c.vx * fx + c.vy * fy;
  let vl = c.vx * px + c.vy * py;
  const off = c.d > HW + 2; // fora do asfalto: mais lento
  const maxv = (off ? MAXV * 0.5 : MAXV) * c.sf;

  if (c.canDrive) {
    if (inp.up) vf += ACC * dt;
    if (inp.down) { if (vf > 4) vf -= BRAKE * dt; else vf -= ACC * 0.6 * dt; }
    if (!inp.up && !inp.down) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 30 * dt);
  }
  if (vf > maxv) vf -= (vf - maxv) * Math.min(1, 5 * dt);
  if (vf < -MAXREV) vf = -MAXREV;
  vf -= vf * (0.35 + (off ? 1.6 : 0)) * dt;
  vl -= vl * Math.min(1, 6.5 * dt);

  const steer = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  if (c.canDrive) c.a += steer * TURN * dt * clamp(vf / 32, -1, 1);

  c.vx = fx * vf + px * vl;
  c.vy = fy * vf + py * vl;
  c.x += c.vx * dt;
  c.y += c.vy * dt;
  updateTrack(c);
  constrain(c);
}

function collide(cars) {
  const R = 11;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R || d2 === 0) continue;
      const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, ov = (R - d) / 2;
      a.x -= nx * ov; a.y -= ny * ov; b.x += nx * ov; b.y += ny * ov;
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel < 0) {
        const j2 = -rel * 0.55;
        a.vx -= nx * j2; a.vy -= ny * j2; b.vx += nx * j2; b.vy += ny * j2;
      }
    }
  }
}

// Piloto automático: segue a linha central olhando alguns metros à frente
function botInput(c, dt) {
  const sp = Math.hypot(c.vx, c.vy);
  const look = 10 + Math.floor(sp / 14);
  const tp = track[(c.idx + look) % N];
  const tx = tp.x + tp.nx * c.lane, ty = tp.y + tp.ny * c.lane;
  const diff = wrapAngle(Math.atan2(ty - c.y, tx - c.x) - c.a);
  const curv = Math.abs(wrapAngle(track[(c.idx + 22) % N].ang - track[c.idx].ang));
  const inp = c.input;

  if (c.reverseT > 0) {
    c.reverseT -= dt;
    inp.up = false; inp.down = true; inp.left = diff > 0; inp.right = diff <= 0;
    return inp;
  }
  inp.left = diff < -0.05;
  inp.right = diff > 0.05;
  const tooFast = sp > 85 && (curv > 0.85 || Math.abs(diff) > 0.7);
  inp.up = !tooFast;
  inp.down = sp > 70 && Math.abs(diff) > 1.0;
  if (c.canDrive && sp < 5) {
    c.stuckT += dt;
    if (c.stuckT > 1) { c.stuckT = 0; c.reverseT = 0.8; }
  } else c.stuckT = 0;
  return inp;
}

function ranking(cars) {
  return [...cars].sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.prog - a.prog;
  });
}
/* ===================== FIM DO MOTOR ===================== */


/* ============================================================
   INTERFACE, DESENHO, MODO LOCAL E MODO ONLINE
   ============================================================ */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const SCREENS = ['menu', 'local', 'online', 'lobby', 'game'];
const STEP = 1 / 60;
const SC = 2; // resolução interna: 2 pixels por unidade do mundo (nítido em telas grandes e de celular)
const PREFIX = 'neonracers-';
const FONT = '"Orbitron", "Rajdhani", system-ui, sans-serif';
const IS_TOUCH = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 0;

// Opções do PeerJS. O padrão já inclui servidores STUN e TURN, que ajudam a conectar
// aparelhos em redes diferentes (ex.: PC no Wi-Fi e celular no 4G/5G).
// Para usar o seu próprio servidor/TURN, acrescente aqui: host, port, path, config: { iceServers: [...] }
const PEER_OPTS = { debug: 0 };

let game = null;     // corrida em andamento
let net = null;      // conexão online
let localCfg = null; // última configuração do modo local
let artReady = false;

document.body.classList.toggle('is-touch', IS_TOUCH);

function show(id) {
  SCREENS.forEach(s => $('screen-' + s).classList.toggle('active', s === id));
  document.body.dataset.screen = id;
  window.scrollTo(0, 0);
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3200);
}
function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

/* ---------- som (liberado no primeiro toque, exigência do iOS/Android) ---------- */
let actx = null;
function unlockAudio() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch (e) { /* sem áudio, o jogo segue */ }
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, unlockAudio, { passive: true }));
function beep(freq, dur) {
  try {
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.04;
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  } catch (e) { /* ignora */ }
}

/* ---------- tela ligada durante a corrida e tela cheia ---------- */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* ignora */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && game) keepAwake(true); });

const fsRoot = document.documentElement;
const reqFS = fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen;
$('btn-full').hidden = !reqFS || !IS_TOUCH;
$('btn-full').addEventListener('click', () => {
  const inFS = document.fullscreenElement || document.webkitFullscreenElement;
  if (inFS) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
  Promise.resolve(reqFS.call(fsRoot)).then(() => {
    try { screen.orientation.lock('landscape').catch(() => {}); } catch (e) { /* ignora */ }
  }).catch(() => {});
});

/* ---------- arte da pista (desenhada uma vez, em alta resolução) ---------- */
const trackCv = document.createElement('canvas');
const skidCv = document.createElement('canvas');
trackCv.width = skidCv.width = W * SC;
trackCv.height = skidCv.height = H * SC;
const skidCtx = skidCv.getContext('2d');
skidCtx.setTransform(SC, 0, 0, SC, 0, 0);

function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hexPath(g, x, y, r) {
  g.beginPath();
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 3 * k + Math.PI / 6;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (k) g.lineTo(px, py); else g.moveTo(px, py);
  }
  g.closePath();
}

const HUD_BOX = { x: 134, y: 148, w: 180, h: 100 }; // painel do HUD no meio da pista

function buildArt() {
  const g = trackCv.getContext('2d');
  g.setTransform(SC, 0, 0, SC, 0, 0);
  const rnd = mulberry32(11);

  // chão com grade
  g.fillStyle = '#050912'; g.fillRect(0, 0, W, H);
  const rg = g.createRadialGradient(W / 2, H / 2, 20, W / 2, H / 2, 380);
  rg.addColorStop(0, 'rgba(30,90,160,.24)'); rg.addColorStop(1, 'rgba(5,9,18,0)');
  g.fillStyle = rg; g.fillRect(0, 0, W, H);
  g.lineWidth = 0.5;
  for (let x = 0; x <= W; x += 20) {
    g.strokeStyle = x % 100 === 0 ? 'rgba(25,227,255,.16)' : 'rgba(25,227,255,.06)';
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  for (let y = 0; y <= H; y += 20) {
    g.strokeStyle = y % 100 === 0 ? 'rgba(25,227,255,.16)' : 'rgba(25,227,255,.06)';
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }
  g.fillStyle = 'rgba(25,227,255,.4)';
  for (let i = 0; i < 40; i++) g.fillRect(((rnd() * W / 20) | 0) * 20 - 0.75, ((rnd() * H / 20) | 0) * 20 - 0.75, 1.5, 1.5);

  const path = new Path2D();
  track.forEach((p, i) => i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y));
  path.closePath();
  g.lineJoin = 'round';

  // área de escape, zebras neon e asfalto
  g.strokeStyle = '#0b1324'; g.lineWidth = 2 * (HW + 10); g.stroke(path);
  g.save();
  g.shadowColor = '#19e3ff'; g.shadowBlur = 12;
  g.strokeStyle = '#19e3ff'; g.lineWidth = 2 * (HW + 3); g.stroke(path);
  g.restore();
  g.strokeStyle = '#ff3df2'; g.lineWidth = 2 * (HW + 3); g.setLineDash([8, 8]); g.stroke(path); g.setLineDash([]);
  g.strokeStyle = '#141b30'; g.lineWidth = 2 * HW; g.stroke(path);

  // textura do asfalto, faixa central e setas de direção
  for (let i = 0; i < 900; i++) {
    const p = track[rnd() * N | 0], off = (rnd() * 2 - 1) * (HW - 2);
    g.fillStyle = 'rgba(130,170,255,.07)';
    g.fillRect(p.x + p.nx * off, p.y + p.ny * off, 1.2, 0.8);
  }
  g.strokeStyle = 'rgba(200,235,255,.22)'; g.lineWidth = 1; g.setLineDash([5, 9]); g.stroke(path); g.setLineDash([]);
  g.strokeStyle = 'rgba(25,227,255,.24)'; g.lineWidth = 1;
  for (let i = 8; i < N; i += 16) {
    if (Math.abs(i - START) < 5) continue;
    const p = track[i];
    g.save(); g.translate(p.x, p.y); g.rotate(p.ang);
    g.beginPath(); g.moveTo(-3, -5); g.lineTo(2, 0); g.lineTo(-3, 5); g.stroke();
    g.restore();
  }

  // linha de largada quadriculada
  const sp = track[START];
  g.save();
  g.translate(sp.x, sp.y); g.rotate(sp.ang);
  for (let u = -HW; u < HW; u += 4) {
    for (let v = 0; v < 2; v++) {
      g.fillStyle = (((u + HW) / 4 + v) % 2 === 0) ? '#e8f6ff' : '#0b1020';
      g.fillRect(v * 4 - 4, u, 4, 4);
    }
  }
  g.restore();

  // barreira de energia (anel exato a WALL de distância da pista)
  const rc = document.createElement('canvas');
  rc.width = W * SC; rc.height = H * SC;
  const q = rc.getContext('2d');
  q.setTransform(SC, 0, 0, SC, 0, 0);
  q.lineJoin = 'round';
  q.strokeStyle = '#19e3ff'; q.lineWidth = 2 * WALL + 2; q.stroke(path);
  q.globalCompositeOperation = 'destination-out';
  q.lineWidth = 2 * WALL; q.stroke(path);
  g.save();
  g.shadowColor = '#19e3ff'; g.shadowBlur = 10; g.globalAlpha = 0.9;
  g.drawImage(rc, 0, 0, W, H);
  g.restore();
  g.fillStyle = '#c8f8ff';
  for (let i = 0; i < N; i += 6) {
    const p = track[i];
    for (const s of [-1, 1]) {
      const x = p.x + p.nx * (WALL + 0.5) * s, y = p.y + p.ny * (WALL + 0.5) * s;
      let min = 1e9;
      for (let k = 0; k < N; k += 2) min = Math.min(min, Math.hypot(x - track[k].x, y - track[k].y));
      if (min >= WALL - 1.5) { g.beginPath(); g.arc(x, y, 1, 0, 6.2832); g.fill(); }
    }
  }

  // decoração fora da barreira: plataformas hexagonais e torres de luz
  const items = [];
  for (let tries = 0; tries < 4000 && items.length < 34; tries++) {
    const x = 10 + rnd() * (W - 20), y = 18 + rnd() * (H - 26);
    if (x > HUD_BOX.x - 12 && x < HUD_BOX.x + HUD_BOX.w + 12 && y > HUD_BOX.y - 12 && y < HUD_BOX.y + HUD_BOX.h + 12) continue;
    const t = track[nearestIdx(x, y)];
    if (Math.hypot(x - t.x, y - t.y) < WALL + 14) continue;
    if (items.some(o => Math.hypot(o.x - x, o.y - y) < 26)) continue;
    items.push({ x, y, hex: rnd() < 0.6 });
  }
  for (const o of items) {
    if (o.hex) {
      hexPath(g, o.x, o.y, 9); g.fillStyle = 'rgba(25,227,255,.05)'; g.fill();
      g.strokeStyle = 'rgba(25,227,255,.4)'; g.lineWidth = 0.8; g.stroke();
      hexPath(g, o.x, o.y, 5); g.strokeStyle = 'rgba(255,61,242,.45)'; g.stroke();
      g.fillStyle = 'rgba(25,227,255,.8)'; g.fillRect(o.x - 0.7, o.y - 0.7, 1.4, 1.4);
    } else {
      const gr = g.createRadialGradient(o.x, o.y, 0, o.x, o.y, 10);
      gr.addColorStop(0, 'rgba(255,61,242,.5)'); gr.addColorStop(1, 'rgba(255,61,242,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(o.x, o.y, 10, 0, 6.2832); g.fill();
      g.fillStyle = '#0c1426'; g.strokeStyle = '#ff3df2'; g.lineWidth = 0.8;
      g.beginPath(); g.arc(o.x, o.y, 3.5, 0, 6.2832); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(o.x, o.y, 1.1, 0, 6.2832); g.fill();
    }
  }

  // letreiro holográfico na largada
  const sx = Math.round(sp.x - 44);
  g.fillStyle = 'rgba(25,227,255,.12)'; g.fillRect(sx, 2, 88, 11);
  g.strokeStyle = '#19e3ff'; g.lineWidth = 0.6; g.strokeRect(sx, 2, 88, 11);
  g.fillStyle = '#d8f6ff'; g.font = '700 5.5px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('NEON RACERS', sx + 44, 8);
}

/* ---------- carros (sprites com brilho, desenhados uma vez) ---------- */
const carSprites = [];
function buildSprites() {
  COLORS.forEach((col, i) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 24 * SC;
    const g = cv.getContext('2d');
    g.setTransform(SC, 0, 0, SC, 12 * SC, 12 * SC);
    g.shadowColor = col.c; g.shadowBlur = 9;
    g.fillStyle = col.c;
    g.beginPath();
    g.moveTo(0, -8); g.lineTo(3, -4.5); g.lineTo(3.6, 3); g.lineTo(2.6, 8);
    g.lineTo(-2.6, 8); g.lineTo(-3.6, 3); g.lineTo(-3, -4.5); g.closePath();
    g.fill();
    g.shadowBlur = 0;
    g.fillStyle = '#05070d';
    [[-5.2, -5], [3.4, -5], [-5.2, 3], [3.4, 3]].forEach(([x, y]) => g.fillRect(x, y, 1.9, 4));
    g.fillStyle = col.d; g.fillRect(-4.2, 6.4, 8.4, 1.6);
    g.fillStyle = '#08101f';
    g.beginPath(); g.moveTo(0, -4); g.lineTo(2, -1); g.lineTo(1.8, 3); g.lineTo(-1.8, 3); g.lineTo(-2, -1); g.closePath(); g.fill();
    g.fillStyle = 'rgba(120,230,255,.75)'; g.fillRect(-1, -2.2, 2, 1.2);
    g.fillStyle = '#fff'; g.fillRect(-0.6, -7.6, 1.2, 1);
    g.fillStyle = '#ff3040'; g.fillRect(-2, 7.7, 1.4, 0.8); g.fillRect(0.6, 7.7, 1.4, 0.8);
    carSprites[i] = cv;
  });
}

function drawCar(g, c) {
  g.save();
  g.translate(c.dx, c.dy);
  g.rotate(c.da + Math.PI / 2);
  g.fillStyle = 'rgba(0,0,0,.4)';
  g.beginPath(); g.ellipse(1.5, 2, 4.5, 8.5, 0, 0, 6.2832); g.fill();
  g.drawImage(carSprites[c.slot % 8], -12, -12, 24, 24);
  g.restore();
}

const canvas = $('game');
const ctx = canvas.getContext('2d');
const bgCtx = $('bg').getContext('2d');
ctx.setTransform(SC, 0, 0, SC, 0, 0);
bgCtx.setTransform(SC, 0, 0, SC, 0, 0);

function txt(g, s, x, y, size, color, align, glow) {
  g.font = '700 ' + size + 'px ' + FONT;
  g.textAlign = align || 'left';
  g.textBaseline = 'top';
  g.fillStyle = 'rgba(2,6,16,.9)'; g.fillText(s, x + 0.6, y + 0.6);
  if (glow) {
    g.save(); g.shadowColor = glow; g.shadowBlur = 10; g.fillStyle = color; g.fillText(s, x, y); g.restore();
  } else { g.fillStyle = color; g.fillText(s, x, y); }
}

function focusCar(gm) {
  if (gm.mode === 'local') return gm.cars.find(c => c.human && c.keymap === 0) || gm.cars.find(c => c.human) || null;
  return gm.cars.find(c => c.slot === net.mySlot) || null;
}

function drawHud(g, gm) {
  const f = focusCar(gm);
  const rk = ranking(gm.cars);
  const lead = f || rk[0];
  const pos = rk.indexOf(lead) + 1;
  const lap = clamp(Math.floor(lead.prog / N) + 1, 1, gm.laps);
  const { x, y, w, h } = HUD_BOX;

  g.fillStyle = 'rgba(6,12,28,.74)'; g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(25,227,255,.5)'; g.lineWidth = 0.6; g.strokeRect(x, y, w, h);
  g.strokeStyle = '#19e3ff'; g.lineWidth = 1.3;
  g.beginPath();
  g.moveTo(x, y + 7); g.lineTo(x, y); g.lineTo(x + 7, y);
  g.moveTo(x + w - 7, y + h); g.lineTo(x + w, y + h); g.lineTo(x + w, y + h - 7);
  g.stroke();

  txt(g, 'POS', x + 10, y + 8, 6, '#7f9bc0');
  txt(g, String(pos), x + 10, y + 17, 26, '#ffffff', 'left', '#19e3ff');
  txt(g, '/' + gm.cars.length, x + 10 + (pos >= 10 ? 38 : 22), y + 34, 8, '#7f9bc0');
  txt(g, 'VOLTA', x + 92, y + 8, 6, '#7f9bc0');
  txt(g, lap + '/' + gm.laps, x + 92, y + 20, 15, '#b6ff3b', 'left', '#b6ff3b');

  const kmh = Math.round((f ? f.spd : lead.spd) * 1.6);
  txt(g, 'KM/H', x + 10, y + 58, 6, '#7f9bc0');
  txt(g, String(kmh), x + 10, y + 67, 13, '#19e3ff');
  const bx = x + 58, bw = w - 70, frac = clamp((f ? f.spd : lead.spd) / MAXV, 0, 1);
  g.fillStyle = 'rgba(25,227,255,.15)'; g.fillRect(bx, y + 71, bw, 5);
  const grad = g.createLinearGradient(bx, 0, bx + bw, 0);
  grad.addColorStop(0, '#19e3ff'); grad.addColorStop(1, '#ff3df2');
  g.fillStyle = grad; g.fillRect(bx, y + 71, bw * frac, 5);

  if (f && gm.state === 'racing' && !f.finished && f.spd > 8) {
    const t = track[nearestIdx(f.dx, f.dy)];
    if (Math.cos(f.da) * t.tx + Math.sin(f.da) * t.ty < -0.5 && Math.floor(performance.now() / 350) % 2 === 0) {
      txt(g, 'SENTIDO ERRADO', x + 10, y + 86, 6, '#ff4d5e');
    }
  }
}

function drawScene(g, cars, gm, dt) {
  g.drawImage(trackCv, 0, 0, W, H);
  g.drawImage(skidCv, 0, 0, W, H);

  for (const c of cars) {
    const mx = c.dx - c.pdx, my = c.dy - c.pdy;
    const sp = Math.hypot(mx, my) / Math.max(dt, 0.001);
    c.spd += (sp - c.spd) * 0.15;
    // marcas de pneu quando o carro derrapa
    if (sp > 45 && g === (gm ? ctx : bgCtx)) {
      const diff = Math.abs(wrapAngle(Math.atan2(my, mx) - c.da));
      if (diff > 0.3 && diff < 1.3) {
        const fx = Math.cos(c.da), fy = Math.sin(c.da);
        skidCtx.fillStyle = 'rgba(0,0,0,.4)';
        for (const s of [-3.5, 3.5]) skidCtx.fillRect(c.dx - fx * 5 - fy * s, c.dy - fy * 5 + fx * s, 0.9, 0.9);
      }
    }
    c.pdx = c.dx; c.pdy = c.dy;
  }

  [...cars].sort((a, b) => a.dy - b.dy).forEach(c => drawCar(g, c));
  if (!gm) return;

  // nomes dos pilotos humanos e marcador do jogador
  for (const c of gm.cars) if (c.human) txt(g, c.name, c.dx, c.dy - 17, 4.5, '#ffffff', 'center');
  if (gm.mode !== 'local') {
    const me = focusCar(gm);
    if (me) {
      g.fillStyle = '#b6ff3b';
      const x = me.dx, y = me.dy - 22;
      g.beginPath(); g.moveTo(x - 2.5, y); g.lineTo(x + 2.5, y); g.lineTo(x, y + 3.5); g.closePath(); g.fill();
    }
  }

  drawHud(g, gm);

  if (gm.state === 'countdown') {
    txt(g, String(Math.max(1, Math.ceil(gm.cd))), W / 2, 166, 52, '#ffffff', 'center', '#19e3ff');
  } else if (gm.state === 'racing' && gm.time < 0.9) {
    txt(g, 'VAI!', W / 2, 176, 30, '#b6ff3b', 'center', '#b6ff3b');
  }
}

/* ---------- fundo animado dos menus ---------- */
let demo = [];
function makeDemo() {
  demo = [];
  for (let k = 0; k < 6; k++) {
    const c = makeCar(k, 'BOT', false, k);
    const i = (START + k * 56) % N, p = track[i];
    c.x = p.x + p.nx * c.lane * 0.6; c.y = p.y + p.ny * c.lane * 0.6; c.a = p.ang;
    c.idx = i; c.prog = 0; c.canDrive = true; c.sf = 0.78 + Math.random() * 0.15;
    c.dx = c.x; c.dy = c.y; c.da = c.a; c.pdx = c.x; c.pdy = c.y;
    demo.push(c);
  }
}
function demoStep(dt) {
  for (const c of demo) { botInput(c, dt); stepCar(c, dt); }
  collide(demo);
  for (const c of demo) { c.dx = c.x; c.dy = c.y; c.da = c.a; }
}

/* ---------- entrada (teclado e toque) ---------- */
const KEYMAPS = [
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' },
  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' },
  { up: 'KeyT', down: 'KeyG', left: 'KeyF', right: 'KeyH' },
  { up: 'KeyI', down: 'KeyK', left: 'KeyJ', right: 'KeyL' }
];
const KEY_LABELS = ['W A S D', 'Setas do teclado', 'T F G H', 'I J K L'];
const keys = new Set();
const touch = { up: false, down: false, left: false, right: false };

window.addEventListener('keydown', e => {
  if (document.body.dataset.screen === 'game' && /^(Arrow|Space)/.test(e.code)) e.preventDefault();
  keys.add(e.code);
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); for (const k in touch) touch[k] = false; });

// Botões de toque: cada botão responde ao seu próprio dedo (vários ao mesmo tempo)
document.querySelectorAll('[data-touch]').forEach(b => {
  const k = b.dataset.touch;
  const set = v => { touch[k] = v; b.classList.toggle('on', v); };
  b.addEventListener('pointerdown', e => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (err) { /* ignora */ } set(true); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => b.addEventListener(ev, () => set(false)));
  b.addEventListener('contextmenu', e => e.preventDefault());
});

const readMap = (m, withTouch) => ({
  up: keys.has(m.up) || (withTouch && touch.up),
  down: keys.has(m.down) || (withTouch && touch.down),
  left: keys.has(m.left) || (withTouch && touch.left),
  right: keys.has(m.right) || (withTouch && touch.right)
});
function onlineInput() {
  const a = readMap(KEYMAPS[0], true), b = readMap(KEYMAPS[1], false);
  return { up: a.up || b.up, down: a.down || b.down, left: a.left || b.left, right: a.right || b.right };
}

/* ---------- corrida ---------- */
function startRace({ mode, roster, laps }) {
  const cars = roster.map((r, k) => {
    const c = makeCar(r.slot, r.name, r.human, k);
    if (r.keymap !== undefined) c.keymap = r.keymap;
    c.dx = c.tx = c.pdx = c.x; c.dy = c.ty = c.pdy = c.y; c.da = c.ta = c.a;
    return c;
  });
  skidCtx.clearRect(0, 0, W, H);
  game = {
    mode, cars, laps, state: 'countdown', cd: 3, time: 0, lastN: 0,
    authority: mode !== 'online-guest', firstFinish: null, gotSnap: false
  };
  $('results').hidden = true;
  $('game-hint').textContent = mode === 'local'
    ? cars.filter(c => c.human).map(c => c.name + ': ' + KEY_LABELS[c.keymap]).join(' | ')
    : (IS_TOUCH ? 'Use os botões de toque ou o teclado.' : 'Controles: W A S D ou setas.');
  keepAwake(true);
  show('game');
  updateRanking();
}

function simulate(dt) {
  const g = game, cars = g.cars;
  if (g.state === 'countdown') {
    g.cd -= dt;
    const n = Math.ceil(g.cd);
    if (n !== g.lastN && n > 0) { g.lastN = n; beep(440, 0.12); }
    if (g.cd <= 0) { g.state = 'racing'; g.time = 0; cars.forEach(c => c.canDrive = true); beep(880, 0.35); }
  } else g.time += dt;

  for (const c of cars) {
    if (!c.human || c.auto) botInput(c, dt);
    else if (g.mode === 'local') c.input = readMap(KEYMAPS[c.keymap], c.keymap === 0);
    else if (c.slot === net.mySlot) c.input = onlineInput();
    stepCar(c, dt);
  }
  collide(cars);

  for (const c of cars) {
    if (!c.finished && c.prog >= g.laps * N) {
      c.finished = true; c.finishTime = g.time;
      if (c.human) c.auto = true;
      if (g.firstFinish === null) g.firstFinish = g.time;
    }
  }
  if (g.state === 'racing') {
    const humans = cars.filter(c => c.human);
    if (humans.every(c => c.finished) || (g.firstFinish !== null && g.time - g.firstFinish > 30)) {
      g.state = 'over';
      showResults();
    }
  }
}

function focusSlot() {
  const f = game && focusCar(game);
  return f ? f.slot : -1;
}

function showResults() {
  const g = game, me = focusSlot();
  const rk = ranking(g.cars);
  $('res-list').innerHTML = rk.map((c, i) =>
    `<li class="${c.slot === me ? 'me' : ''}"><span class="p">${i + 1}.</span>` +
    `<span class="dot" style="color:${COLORS[c.slot].c};background:${COLORS[c.slot].c}"></span>` +
    `<span class="n">${esc(c.name)}</span><span class="t">${c.finished ? fmtTime(c.finishTime) : '--'}</span></li>`
  ).join('');
  const local = g.mode === 'local', host = g.mode === 'online-host';
  $('res-again').hidden = !local;
  $('res-lobby').hidden = !host;
  $('res-note').textContent = g.mode === 'online-guest' ? 'Aguardando o anfitrião voltar para a sala.' : '';
  $('results').hidden = false;
}

function updateRanking() {
  if (!game) return;
  const g = game, me = focusSlot();
  $('rank-list').innerHTML = ranking(g.cars).map((c, i) =>
    `<li class="${g.mode !== 'local' && c.slot === me ? 'me' : ''}"><span class="p">${i + 1}</span>` +
    `<span class="dot" style="color:${COLORS[c.slot].c};background:${COLORS[c.slot].c}"></span>` +
    `<span class="n">${esc(c.name)}</span>` +
    `<span class="l">${c.finished ? 'FIM' : 'V' + clamp(Math.floor(c.prog / N) + 1, 1, g.laps)}</span></li>`
  ).join('');
}

/* ---------- modo local ---------- */
function refreshLocal() {
  const total = +$('loc-total').value;
  let h = +$('loc-humans').value;
  if (h > total) { h = total; $('loc-humans').value = h; }
  $('loc-keys').innerHTML = Array.from({ length: h }, (_, i) =>
    `<li><span class="dot" style="color:${COLORS[i].c};background:${COLORS[i].c}"></span>P${i + 1} (${COLORS[i].name}): ${KEY_LABELS[i]}</li>`
  ).join('');
  $('loc-touch-note').hidden = !IS_TOUCH;
}
function startLocal() {
  const total = +$('loc-total').value, h = +$('loc-humans').value, laps = +$('loc-laps').value;
  localCfg = { total, h, laps };
  const roster = [];
  for (let i = 0; i < total; i++) {
    roster.push(i < h
      ? { slot: i, name: 'P' + (i + 1), human: true, keymap: i }
      : { slot: i, name: 'BOT' + (i - h + 1), human: false });
  }
  startRace({ mode: 'local', roster: shuffle(roster), laps });
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.random() * (i + 1) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ============================================================
   MODO ONLINE (salas)
   O anfitrião roda a simulação; os outros enviam suas teclas/toques
   e recebem a posição dos carros. Computador, celular e tablet
   usam exatamente o mesmo protocolo, então jogam juntos.
   A conexão é feita pelo PeerJS (WebRTC).
   ============================================================ */
const cleanName = s => (String(s || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 10)) || 'Piloto';
const getName = () => cleanName($('on-name').value);
const setStatus = m => { $('on-status').textContent = m || ''; };

function genCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += a[Math.random() * a.length | 0];
  return s;
}

function leaveNet() {
  const n = net;
  net = null;
  game = null;
  if (n) { try { n.peer.destroy(); } catch (e) { /* já fechado */ } }
}

/* --- anfitrião --- */
function createRoom() {
  if (typeof Peer === 'undefined') { setStatus('Não foi possível carregar o PeerJS. Verifique sua conexão.'); return; }
  leaveNet();
  setStatus('Criando sala...');
  const name = getName();
  const attempt = () => {
    const code = genCode();
    const peer = new Peer(PREFIX + code, PEER_OPTS);
    peer.on('open', () => {
      net = { peer, isHost: true, code, mySlot: 0, conns: {}, players: [{ slot: 0, name }], laps: 3, fill: 0, inRace: false, acc: 0 };
      $('lobby-laps').value = '3'; $('lobby-fill').value = '0';
      setStatus('');
      show('lobby');
      renderLobby();
    });
    peer.on('connection', conn => hostConnection(conn));
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { /* ignora */ } });
    peer.on('error', e => {
      if (e.type === 'unavailable-id') { peer.destroy(); attempt(); }
      else if (!net) setStatus('Erro ao criar a sala (' + e.type + '). Tente de novo.');
      else toast('Erro de conexão: ' + e.type);
    });
  };
  attempt();
}

function hostConnection(conn) {
  conn.on('data', m => hostData(conn, m));
  conn.on('close', () => hostDrop(conn));
  conn.on('error', () => hostDrop(conn));
}

function hostData(conn, m) {
  if (!net || !m) return;
  if (m.t === 'hello') {
    if (conn.slot !== undefined) return;
    if (net.inRace) { conn.send({ t: 'busy' }); setTimeout(() => conn.close(), 300); return; }
    const used = new Set(net.players.map(p => p.slot));
    let slot = -1;
    for (let i = 0; i < 8; i++) if (!used.has(i)) { slot = i; break; }
    if (slot < 0) { conn.send({ t: 'full' }); setTimeout(() => conn.close(), 300); return; }
    conn.slot = slot;
    net.conns[slot] = conn;
    net.players.push({ slot, name: cleanName(m.name) });
    conn.send({ t: 'welcome', slot });
    broadcastLobby();
  } else if (m.t === 'input' && conn.slot !== undefined && game) {
    const c = game.cars.find(x => x.slot === conn.slot);
    if (c && c.human) {
      const b = m.b | 0;
      c.input = { up: !!(b & 1), down: !!(b & 2), left: !!(b & 4), right: !!(b & 8) };
    }
  }
}

function hostDrop(conn) {
  if (!net || conn.slot === undefined) return;
  const slot = conn.slot;
  conn.slot = undefined;
  delete net.conns[slot];
  const p = net.players.find(x => x.slot === slot);
  net.players = net.players.filter(x => x.slot !== slot);
  if (game) {
    const c = game.cars.find(x => x.slot === slot);
    if (c) c.human = false; // vira bot
    toast((p ? p.name : 'Um jogador') + ' saiu da corrida.');
  } else {
    broadcastLobby();
  }
}

function lobbyMsg() {
  return { t: 'lobby', players: net.players.map(p => ({ slot: p.slot, name: p.name })), laps: net.laps, fill: net.fill };
}
function broadcastLobby() {
  const m = lobbyMsg();
  for (const s in net.conns) { try { net.conns[s].send(m); } catch (e) { /* ignora */ } }
  renderLobby();
}

function renderLobby() {
  if (!net) return;
  $('lobby-code').textContent = net.code;
  const list = [...net.players].sort((a, b) => a.slot - b.slot);
  $('lobby-players').innerHTML = list.map(p => {
    const tags = [];
    if (p.slot === 0) tags.push('ANFITRIÃO');
    if (p.slot === net.mySlot) tags.push('VOCÊ');
    return `<li><span class="dot" style="color:${COLORS[p.slot].c};background:${COLORS[p.slot].c}"></span>${esc(p.name)}` +
      `<span class="tag">${tags.join(' | ')}</span></li>`;
  }).join('');
  $('lobby-host').hidden = !net.isHost;
  $('lobby-guest').hidden = net.isHost;
  if (net.isHost) {
    const total = net.fill > 0 ? Math.max(net.players.length, net.fill) : net.players.length;
    $('btn-start').disabled = total < 2;
    $('lobby-guest').textContent = '';
  } else {
    $('lobby-guest').textContent = `Voltas: ${net.laps}. Aguardando o anfitrião iniciar a corrida...`;
  }
}

function hostStart() {
  if (!net || !net.isHost) return;
  const roster = net.players.map(p => ({ slot: p.slot, name: p.name, human: true }));
  if (net.fill > 0) {
    const used = new Set(roster.map(r => r.slot));
    let n = 1;
    for (let i = 0; i < 8 && roster.length < net.fill; i++) {
      if (!used.has(i)) { roster.push({ slot: i, name: 'BOT' + n++, human: false }); used.add(i); }
    }
  }
  if (roster.length < 2) { toast('Precisa de pelo menos 2 pilotos. Ative os bots ou chame um amigo.'); return; }
  shuffle(roster);
  net.inRace = true;
  for (const s in net.conns) { try { net.conns[s].send({ t: 'start', roster, laps: net.laps }); } catch (e) { /* ignora */ } }
  startRace({ mode: 'online-host', roster, laps: net.laps });
}

function hostBroadcast(dt) {
  net.acc += dt;
  if (net.acc < 0.05) return;
  net.acc = 0;
  const g = game;
  const msg = {
    t: 'snap', s: g.state, cd: +g.cd.toFixed(2), tm: +g.time.toFixed(2),
    c: g.cars.map(c => [c.slot, +c.x.toFixed(1), +c.y.toFixed(1), +c.a.toFixed(2), Math.round(c.prog), c.finished ? 1 : 0, +c.finishTime.toFixed(2)])
  };
  for (const s in net.conns) { try { net.conns[s].send(msg); } catch (e) { /* ignora */ } }
}

function hostBackToLobby() {
  if (!net) return;
  net.inRace = false;
  game = null;
  keepAwake(false);
  $('results').hidden = true;
  show('lobby');
  broadcastLobby();
}

/* --- convidado --- */
function joinRoom() {
  if (typeof Peer === 'undefined') { setStatus('Não foi possível carregar o PeerJS. Verifique sua conexão.'); return; }
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length < 4) { setStatus('Digite o código da sala.'); return; }
  leaveNet();
  setStatus('Conectando...');
  const peer = new Peer(PEER_OPTS);
  net = { peer, isHost: false, code, mySlot: -1, players: [], laps: 3, fill: 0, joined: false, lastBits: -1, lastSend: 0 };
  const mine = () => net && net.peer === peer;
  const fail = msg => { if (mine()) leaveNet(); setStatus(msg); };

  peer.on('error', e => fail(e.type === 'peer-unavailable' ? 'Sala não encontrada. Confira o código.' : 'Erro de conexão (' + e.type + ').'));
  peer.on('open', () => {
    const conn = peer.connect(PREFIX + code, { serialization: 'json', reliable: true });
    if (!mine()) return;
    net.hostConn = conn;
    conn.on('open', () => conn.send({ t: 'hello', name: getName() }));
    conn.on('data', m => guestData(m));
    conn.on('close', () => {
      if (!mine()) return;
      leaveNet();
      keepAwake(false);
      toast('A sala foi encerrada.');
      show('menu');
    });
  });
  setTimeout(() => { if (mine() && !net.joined) fail('Tempo esgotado. A sala existe e está aberta?'); }, 15000);
}

function guestData(m) {
  if (!net || !m) return;
  switch (m.t) {
    case 'welcome': net.mySlot = m.slot; break;
    case 'busy': leaveNet(); setStatus('A corrida dessa sala já começou.'); break;
    case 'full': leaveNet(); setStatus('A sala está cheia (máximo de 8).'); break;
    case 'lobby':
      net.joined = true;
      net.players = m.players; net.laps = m.laps; net.fill = m.fill;
      if (game) { game = null; keepAwake(false); $('results').hidden = true; }
      if (document.body.dataset.screen !== 'lobby') { setStatus(''); show('lobby'); }
      renderLobby();
      break;
    case 'start':
      net.joined = true;
      startRace({ mode: 'online-guest', roster: m.roster, laps: m.laps });
      break;
    case 'snap': applySnap(m); break;
  }
}

function applySnap(m) {
  const g = game;
  if (!g) return;
  g.cd = m.cd; g.time = m.tm;
  for (const e of m.c) {
    const c = g.cars.find(x => x.slot === e[0]);
    if (!c) continue;
    c.tx = e[1]; c.ty = e[2]; c.ta = e[3];
    if (!g.gotSnap) { c.dx = c.pdx = c.tx; c.dy = c.pdy = c.ty; c.da = c.ta; }
    c.prog = e[4]; c.finished = !!e[5]; c.finishTime = e[6];
  }
  g.gotSnap = true;
  if (g.state === 'countdown') {
    const n = Math.ceil(g.cd);
    if (n !== g.lastN && n > 0) { g.lastN = n; beep(440, 0.12); }
  }
  if (m.s !== g.state) {
    g.state = m.s;
    if (m.s === 'racing') beep(880, 0.35);
    if (m.s === 'over') showResults();
  }
}

function clientUpdate(dt) {
  const k = 1 - Math.exp(-dt * 16);
  for (const c of game.cars) {
    c.dx += (c.tx - c.dx) * k;
    c.dy += (c.ty - c.dy) * k;
    c.da += wrapAngle(c.ta - c.da) * k;
  }
}
function clientSend(now) {
  if (!net || !net.hostConn) return;
  const i = onlineInput();
  const bits = (i.up ? 1 : 0) | (i.down ? 2 : 0) | (i.left ? 4 : 0) | (i.right ? 8 : 0);
  if (bits !== net.lastBits || now - net.lastSend > 250) {
    net.lastBits = bits; net.lastSend = now;
    try { net.hostConn.send({ t: 'input', b: bits }); } catch (e) { /* ignora */ }
  }
}

function copyLink() {
  if (!net) return;
  const url = location.href.split('?')[0].split('#')[0] + '?sala=' + net.code;
  const done = () => toast('Link da sala copiado!');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done).catch(() => window.prompt('Copie o link da sala:', url));
  else window.prompt('Copie o link da sala:', url);
}

function quitToMenu() {
  if (net) leaveNet();
  game = null;
  keepAwake(false);
  setStatus('');
  show('menu');
}

/* ---------- laço principal ---------- */
let last = performance.now(), rankT = 0, acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!artReady) return;

  if (!game) {
    demoStep(Math.min(dt, 0.033));
    if (document.body.dataset.screen !== 'game') drawScene(bgCtx, demo, null, dt);
    return;
  }
  if (game.authority) {
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < 6) { simulate(STEP); acc -= STEP; n++; }
    if (n === 6) acc = 0;
    for (const c of game.cars) { c.dx = c.x; c.dy = c.y; c.da = c.a; }
    if (net && net.isHost) hostBroadcast(dt);
  } else {
    clientUpdate(dt);
    clientSend(now);
  }
  drawScene(ctx, game.cars, game, dt);
  rankT += dt;
  if (rankT > 0.2) { rankT = 0; updateRanking(); }
}

/* ---------- eventos da interface ---------- */
$('btn-local').addEventListener('click', () => { refreshLocal(); show('local'); });
$('btn-online').addEventListener('click', () => { setStatus(''); show('online'); });
document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', quitToMenu));

$('loc-total').addEventListener('change', refreshLocal);
$('loc-humans').addEventListener('change', refreshLocal);
$('loc-start').addEventListener('click', startLocal);

$('btn-create').addEventListener('click', createRoom);
$('btn-join').addEventListener('click', joinRoom);
$('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('on-name').addEventListener('change', () => { try { localStorage.setItem('nr-nome', getName()); } catch (e) { /* ignora */ } });

$('btn-copy').addEventListener('click', copyLink);
$('btn-leave').addEventListener('click', quitToMenu);
$('btn-start').addEventListener('click', hostStart);
$('lobby-laps').addEventListener('change', () => { if (net && net.isHost) { net.laps = +$('lobby-laps').value; broadcastLobby(); } });
$('lobby-fill').addEventListener('change', () => { if (net && net.isHost) { net.fill = +$('lobby-fill').value; broadcastLobby(); } });

$('btn-quit').addEventListener('click', () => { if (window.confirm('Sair da corrida?')) quitToMenu(); });
$('res-again').addEventListener('click', () => { if (localCfg) startLocal(); });
$('res-lobby').addEventListener('click', hostBackToLobby);
$('res-menu').addEventListener('click', quitToMenu);

/* ---------- início ---------- */
(function init() {
  let saved = '';
  try { saved = localStorage.getItem('nr-nome') || ''; } catch (e) { /* ignora */ }
  $('on-name').value = saved || 'Piloto' + (10 + (Math.random() * 90 | 0));

  const q = new URLSearchParams(location.search).get('sala');
  if (q) { $('join-code').value = q.toUpperCase().slice(0, 5); show('online'); }

  makeDemo();
  const fontReady = (document.fonts && document.fonts.load)
    ? Promise.race([document.fonts.load('700 10px Orbitron'), new Promise(r => setTimeout(r, 1500))])
    : Promise.resolve();
  fontReady.catch(() => {}).then(() => { buildArt(); buildSprites(); artReady = true; });
  requestAnimationFrame(frame);
})();

})();
