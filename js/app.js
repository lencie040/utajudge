import { HOP, yin, freqToMidi, midiName, wrapOct } from "./pitch.js";
import { analyze } from "./analysis.js";
import { score, rankOf } from "./scoring.js";

const $ = (s) => document.querySelector(s);
const LS_KEY = "utajudge-best-v1";

const app = {
  songs: [],
  song: null,      // index.json の項目
  meta: null,      // meta.json
  refMidi: null,   // お手本（10ms, NaN=無声）
  refNotes: [],    // お手本の音（描画用）
  lo: 50, hi: 75,  // 描画する音程の範囲
  audio: null,
  ctx: null, analyser: null, stream: null, buf: null,
  usr: [],         // [{t, midi}] 歌唱の生データ
  lastUser: null,  // {t, midi} 直近の有声フレーム
  playing: false,
  streak: 0, bestStreak: 0, lastJudgeAt: -1,
  rafId: 0,
  outLat: 0,       // 再生の出力遅延（秒）
  comp: 0.1,       // 歌声の時刻補正（秒）＝出力遅延＋マイク遅延
};

// ---------- 画面切り替え ----------
function show(view) {
  for (const v of document.querySelectorAll(".view")) v.classList.toggle("active", v.id === `view-${view}`);
  window.scrollTo({ top: 0 });
}

// ---------- ベスト記録（端末内のみ・失敗しても無視） ----------
function loadBest() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
}
function saveBest(id, result) {
  try {
    const all = loadBest();
    if (!all[id] || result.value > all[id].value) {
      all[id] = { value: result.value, rank: result.rank, at: Date.now() };
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    }
  } catch { /* 保存できなくても続行 */ }
}

// ---------- 曲一覧 ----------
function hueOf(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
async function renderList() {
  const grid = $("#song-grid");
  grid.innerHTML = "";
  let list = [];
  try {
    list = await (await fetch("songs/index.json", { cache: "no-cache" })).json();
  } catch {
    grid.textContent = "曲一覧を読み込めませんでした。";
  }
  const best = loadBest();
  app.songs = list;
  for (const s of list) {
    const b = best[s.id];
    const btn = document.createElement("button");
    btn.className = "card";
    btn.style.setProperty("--h", hueOf(s.id));
    btn.innerHTML = `<div class="inner">
        <div><div class="t"></div><div class="a"></div></div>
        <div>${b ? `<span class="best">BEST ${b.value.toFixed(1)} (${b.rank})</span>` : ""}
        <div class="dur">${fmtTime(s.duration)}</div></div></div>`;
    btn.querySelector(".t").textContent = s.title;
    btn.querySelector(".a").textContent = s.artist || "オリジナル";
    btn.addEventListener("click", () => startSong(s));
    grid.appendChild(btn);
  }
  if (!list.length) grid.textContent = "曲がまだありません。songs/ に曲を追加してください。";
}

// ---------- 準備 ----------
async function loadSong(s) {
  const base = s.dir + "/";
  const [meta, ref] = await Promise.all([
    fetch(base + "meta.json").then((r) => r.json()),
    fetch(base + "ref.json").then((r) => r.json()),
  ]);
  app.meta = meta;
  app.refMidi = Float64Array.from(ref.midi, (v) => (v === null ? NaN : v));
  const a = analyze(app.refMidi);
  app.refNotes = a.notes.filter((n) => n.dur >= 0.1);
  // 描画の音程範囲：お手本の有声音の 2〜98%点 ±3半音
  const vals = Array.from(app.refMidi).filter((v) => !Number.isNaN(v)).sort((x, y) => x - y);
  const pct = (p) => vals[Math.floor((vals.length - 1) * p)] ?? 60;
  app.lo = pct(0.02) - 3;
  app.hi = pct(0.98) + 3;
  if (app.hi - app.lo < 12) app.hi = app.lo + 12;
  app.audio = new Audio(base + meta.audio);
  app.audio.preload = "auto";
  app.audio.volume = Number($("#guide-vol").value);
}

async function startMic() {
  app.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
  });
  app.ctx = new (window.AudioContext || window.webkitAudioContext)();
  app.outLat = app.ctx.outputLatency || app.ctx.baseLatency || 0.05;
  // 初期値：出力遅延＋マイク遅延の一般的な目安（60ms）＋解析窓の半分（23ms）
  setComp(Math.round((app.outLat + 0.06 + 0.023) * 1000));
  const src = app.ctx.createMediaStreamSource(app.stream);
  app.analyser = app.ctx.createAnalyser();
  app.analyser.fftSize = 2048;
  app.analyser.smoothingTimeConstant = 0;
  src.connect(app.analyser);
  app.buf = new Float32Array(app.analyser.fftSize);
}

function stopMic() {
  try { app.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { app.ctx?.close(); } catch {}
  app.stream = null; app.ctx = null; app.analyser = null;
}

// マイクのズレ補正（ミリ秒）
function setComp(ms) {
  app.comp = ms / 1000;
  $("#lat").value = String(ms);
  $("#lat-val").textContent = String(ms);
}

// ---------- 歌唱ループ ----------
function sample(t) {
  if (!app.analyser) return;
  app.analyser.getFloatTimeDomainData(app.buf);
  const p = yin(app.buf, app.ctx.sampleRate);
  const ok = p && p.freq >= 80 && p.freq <= 1000 && p.ap < 0.2 && p.rms > 0.01;
  const midi = ok ? freqToMidi(p.freq) : NaN;
  app.usr.push({ t, midi });
  if (ok) app.lastUser = { t, midi };
}

// 歌唱の生データを、お手本と同じ10ms刻みの配列にする
function toGrid(usr, length, comp) {
  const g = new Float64Array(length).fill(NaN);
  for (let i = 0; i < usr.length; i++) {
    const a = Math.round((usr[i].t - comp) / HOP);
    const next = usr[i + 1] ? Math.round((usr[i + 1].t - comp) / HOP) : a + 1;
    const gap = i + 1 < usr.length ? usr[i + 1].t - usr[i].t : 0;
    const end = gap > 0 && gap <= 0.05 ? next : a + 1;
    for (let k = a; k < end && k < length; k++) if (k >= 0) g[k] = usr[i].midi;
  }
  return g;
}

// 歌唱中のリアルタイム判定（コンボ用・おおよそ）
// tNow は「実際に聞こえている時刻」（お手本の時刻と同じ軸）
function liveJudge(tNow) {
  if (tNow - app.lastJudgeAt < 0.12) return;
  app.lastJudgeAt = tNow;
  const idx = Math.round(tNow / HOP);
  const target = app.refMidi[idx];
  const u = app.lastUser && Math.abs(tNow - (app.lastUser.t - app.comp)) < 0.15 ? app.lastUser.midi : null;
  const judge = $("#judge");
  if (Number.isNaN(target) || u === null) {
    return;
  }
  const err = Math.abs(wrapOct(u - target));
  if (err <= 0.5) {
    app.streak++;
    app.bestStreak = Math.max(app.bestStreak, app.streak);
    if (app.streak % 5 === 0) flash(judge, app.streak >= 20 ? "EXCELLENT!" : app.streak >= 10 ? "GREAT!" : "GOOD!", false);
  } else if (err > 1.2) {
    app.streak = 0;
    flash(judge, "MISS", true);
  }
  const c = $("#combo");
  c.textContent = app.streak >= 3 ? `COMBO ${app.streak}` : "";
  c.classList.remove("pop"); void c.offsetWidth; if (app.streak >= 3) c.classList.add("pop");
}

function flash(el, text, miss) {
  el.textContent = text;
  el.classList.toggle("miss", miss);
  el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
}

// ---------- 描画 ----------
const TIME_BACK = 1.5, TIME_FWD = 3.5;
function draw(t) {
  const cv = $("#pitch");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const xOf = (s) => ((s - (t - TIME_BACK)) / (TIME_BACK + TIME_FWD)) * W;
  const yOf = (m) => H - ((m - app.lo) / (app.hi - app.lo)) * H;

  // 音程の横線（ドレミの線）
  g.font = "12px Orbitron, sans-serif";
  for (let m = Math.ceil(app.lo); m <= app.hi; m++) {
    const y = yOf(m);
    const isC = ((m % 12) + 12) % 12 === 0;
    g.strokeStyle = isC ? "rgba(255,210,63,.35)" : "rgba(255,255,255,.07)";
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    if (isC) { g.fillStyle = "rgba(255,210,63,.7)"; g.fillText(midiName(m), 6, y - 3); }
  }

  // お手本の音（水色のバー）
  for (const n of app.refNotes) {
    const x0 = xOf(n.t0), x1 = xOf(n.t1);
    if (x1 < 0 || x0 > W) continue;
    const y = yOf(n.base) - 7;
    const grd = g.createLinearGradient(0, y, 0, y + 14);
    grd.addColorStop(0, "#9ff3ff"); grd.addColorStop(1, "#1d8fd6");
    g.fillStyle = grd;
    g.shadowColor = "rgba(54,224,255,.7)"; g.shadowBlur = 10;
    roundRect(g, x0, y, Math.max(4, x1 - x0 - 2), 14, 7);
    g.fill();
    g.shadowBlur = 0;
  }

  // あなたの音（黄色の線）
  g.lineWidth = 4; g.lineJoin = "round"; g.lineCap = "round";
  g.strokeStyle = "#ffd23f"; g.shadowColor = "rgba(255,210,63,.9)"; g.shadowBlur = 12;
  g.beginPath();
  let pen = false, prevT = -9;
  for (const p of app.usr) {
    const pt = p.t - app.comp; // 聞こえている時刻に直す
    if (pt < t - TIME_BACK - 0.1 || pt > t + TIME_FWD) continue;
    if (Number.isNaN(p.midi) || p.midi < app.lo - 2 || p.midi > app.hi + 2) { pen = false; continue; }
    const x = xOf(pt), y = yOf(p.midi);
    if (!pen || pt - prevT > 0.08) g.moveTo(x, y); else g.lineTo(x, y);
    pen = true; prevT = pt;
  }
  g.stroke();
  g.shadowBlur = 0;

  // 再生位置
  const px = xOf(t);
  g.strokeStyle = "rgba(255,79,163,.9)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();

  // 歌詞の時刻に合わせた表示（meta.lyrics）
  // 現在のお手本音名
  const ref = app.refMidi[Math.round(t / HOP)];
  $("#ref-note").textContent = Number.isNaN(ref) ? "--" : midiName(ref);
  const u = app.lastUser && Math.abs(t - (app.lastUser.t - app.comp)) < 0.2 ? app.lastUser.midi : null;
  $("#live-note").textContent = u === null ? "--" : midiName(u);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function updateLyrics(t) {
  const L = app.meta?.lyrics || [];
  let i = -1;
  for (let k = 0; k < L.length; k++) if (L[k].t <= t) i = k;
  $("#lyric-now").textContent = i >= 0 ? L[i].text : "";
  $("#lyric-next").textContent = L[i + 1] ? L[i + 1].text : "";
}

// ---------- 再生の流れ ----------
async function startSong(s) {
  show("play");
  $("#play-title").textContent = s.title;
  $("#combo").textContent = "";
  $("#play-msg").textContent = "準備中…";
  try {
    await loadSong(s);
  } catch {
    $("#play-msg").textContent = "曲データを読み込めませんでした。";
    return;
  }
  app.song = s;
  try {
    await startMic();
  } catch {
    $("#play-msg").textContent = "マイクが使えません。ブラウザでマイクの許可をしてください。";
    return;
  }
  $("#play-msg").textContent = "イヤホンをつけてお歌いください。";
  await countdown();
  beginPlaying();
}

function countdown() {
  return new Promise((resolve) => {
    const el = $("#countdown");
    el.classList.remove("hidden");
    const seq = ["3", "2", "1", "GO!"];
    let i = 0;
    const tick = () => {
      el.textContent = seq[i];
      el.classList.remove("tick"); void el.offsetWidth; el.classList.add("tick");
      i++;
      if (i < seq.length) setTimeout(tick, 800);
      else setTimeout(() => { el.classList.add("hidden"); resolve(); }, 500);
    };
    tick();
  });
}

function beginPlaying() {
  app.usr = [];
  app.lastUser = null;
  app.streak = 0; app.bestStreak = 0; app.lastJudgeAt = -1;
  app.playing = true;
  app.audio.currentTime = 0;
  app.audio.onended = () => finish();
  app.audio.play().catch(() => { $("#play-msg").textContent = "再生を開始できませんでした。もう一度お試しください。"; });
  const loop = () => {
    if (!app.playing) return;
    const raw = app.audio.currentTime;          // 再生位置（出力に送った時刻）
    const t = Math.max(0, raw - app.outLat);    // 実際に聞こえている時刻
    sample(raw);
    liveJudge(t);
    draw(t);
    updateLyrics(t);
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    $("#elapsed").textContent = `${m}:${String(s).padStart(2, "0")}`;
    app.rafId = requestAnimationFrame(loop);
  };
  loop();
}

function stopPlaying() {
  app.playing = false;
  cancelAnimationFrame(app.rafId);
  try { app.audio.pause(); } catch {}
  stopMic();
}

function finish() {
  stopPlaying();
  const usrGrid = toGrid(app.usr, app.refMidi.length, app.comp);
  const r = score(app.refMidi, usrGrid);
  saveBest(app.song.id, r);
  showResult(r);
}

// ---------- 結果画面 ----------
function showResult(r) {
  show("result");
  $("#res-title").textContent = app.song.title;
  $("#res-rank").textContent = r.rank;
  $("#res-rank").classList.remove("stamp"); void $("#res-rank").offsetWidth; $("#res-rank").classList.add("stamp");

  // スコアのカウントアップ
  const el = $("#res-score");
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 1400);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = (r.value * e).toFixed(1);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);

  $("#res-stars").textContent = "★".repeat(r.stars) + "☆".repeat(5 - r.stars);

  const bars = [
    ["音程", r.pitch], ["リズム", r.rhythm],
    ["表現", r.expr ?? 0],
  ];
  $("#res-bars").innerHTML = "";
  for (const [label, v] of bars) {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `<span>${label}${label === "表現" && r.expr === null ? "（対象なし）" : ""}</span>
      <div class="bar"><i></i></div><b>${v.toFixed(1)}</b>`;
    $("#res-bars").appendChild(row);
    requestAnimationFrame(() => (row.querySelector("i").style.width = `${Math.min(100, v)}%`));
  }

  const ex = $("#res-expr");
  ex.innerHTML = "";
  const order = ["kob", "sak", "vib", "fal"];
  for (const k of order) {
    const d = r.exprDetail[k];
    const li = document.createElement("li");
    if (!d) {
      li.className = "na";
      li.innerHTML = `<span>${LABELS[k]}</span><b>お手本になし</b>`;
    } else {
      li.innerHTML = `<span>${d.label}</span><b>${d.hit}/${d.total}</b>`;
    }
    ex.appendChild(li);
  }

  const c = $("#res-comments");
  c.innerHTML = "";
  for (const text of r.comments) {
    const li = document.createElement("li");
    li.textContent = text;
    c.appendChild(li);
  }
  drawResultChart(r);
}
const LABELS = { kob: "こぶし", sak: "しゃくり", vib: "ビブラート", fal: "フォール" };

function drawResultChart(r) {
  const cv = $("#res-chart");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!r.notes.length) return;
  const t0 = r.notes[0].t0, t1 = r.notes[r.notes.length - 1].t1;
  const base = H - 22, top = 10;
  for (const n of r.notes) {
    const x = ((n.t0 - t0) / (t1 - t0)) * (W - 8) + 4;
    const w = Math.max(6, ((n.t1 - n.t0) / (t1 - t0)) * (W - 8) - 2);
    const s = Math.min(1, Math.max(0, n.score));
    g.fillStyle = s >= 0.8 ? "#58f0a0" : s >= 0.4 ? "#ffd23f" : "#ff4fa3";
    g.fillRect(x, base - s * (base - top), w, s * (base - top));
  }
  g.fillStyle = "rgba(255,255,255,.5)";
  g.font = "12px sans-serif";
  g.fillText("緑:合っている  黄:ずれ  桃:外れ", 8, H - 6);
}

// ---------- イベント ----------
function init() {
  $("#btn-quit").addEventListener("click", () => { stopPlaying(); show("list"); renderList(); });
  $("#btn-back").addEventListener("click", () => { show("list"); renderList(); });
  $("#btn-retry").addEventListener("click", () => startSong(app.song));
  $("#guide-vol").addEventListener("input", (e) => { if (app.audio) app.audio.volume = Number(e.target.value); });
  $("#lat").addEventListener("input", (e) => setComp(Number(e.target.value)));
  show("list");
  renderList();
}
init();
