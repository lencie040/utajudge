// 採点：音程・リズム・表現（こぶし／しゃくり／ビブラート／フォール）
import { HOP, wrapOct } from "./pitch.js";
import { analyze, median } from "./analysis.js";

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// お手本とユーザーの「音の始まり」のずれ（マイクの遅延・歌い出しの癖）を推定する。
// 全ての組み合わせのずれを集め、最も多く現れる値（±0.8秒の範囲）の中央値を採用する
function estimateLag(refNotes, usrNotes) {
  const d = [];
  for (const r of refNotes) {
    for (const u of usrNotes) {
      const dt = u.t0 - r.t0;
      if (Math.abs(dt) <= 0.8) d.push(dt);
    }
  }
  if (d.length < 2) return 0;
  // 0.1秒幅で最も多い位置を探す
  let mode = 0, bestCount = -1;
  for (const c of d) {
    const cnt = d.reduce((s, x) => s + (Math.abs(x - c) <= 0.1 ? 1 : 0), 0);
    if (cnt > bestCount) { bestCount = cnt; mode = c; }
  }
  const near = d.filter((x) => Math.abs(x - mode) <= 0.1);
  if (near.length < 2) return 0;
  return clamp(median(near), -0.8, 0.8);
}

// usr: 10ms刻みのユーザー音程配列（お手本と同じ時間軸、無声は NaN）
// 戻り値: 採点結果
export function score(refMidi, usrMidi) {
  const R = analyze(refMidi);
  const U = analyze(usrMidi);
  const lag = estimateLag(R.notes, U.notes);

  // --- 音程 -------------------------------------------------------
  let num = 0, den = 0, low = 0, high = 0, miss = 0;
  const noteResults = [];
  const refNotes = R.notes.filter((n) => n.dur >= 0.1);
  for (const note of refNotes) {
    const a = Math.max(0, Math.round((note.t0 + lag) / HOP));
    const b = Math.min(usrMidi.length, Math.round((note.t1 + lag) / HOP));
    const vals = [];
    let total = 0;
    for (let i = a; i < b; i++) {
      total++;
      const v = usrMidi[i];
      if (!Number.isNaN(v)) vals.push(wrapOct(v - note.base));
    }
    const cov = total ? vals.length / total : 0;
    let err = null, acc = 0;
    if (vals.length >= 3) {
      err = median(vals);
      // ±0.5半音まで満点、1.5半音で0点
      acc = clamp(1 - (Math.abs(err) - 0.5), 0, 1);
    }
    const s = acc * Math.min(1, cov / 0.6);
    num += s * note.dur;
    den += note.dur;
    if (err !== null && Math.abs(err) > 0.5) (err < 0 ? low++ : high++);
    if (s < 0.3) miss++;
    noteResults.push({ t0: note.t0, t1: note.t1, base: note.base, score: s, err });
  }
  const pitch = den ? num / den : 0;

  // --- リズム（始まりのタイミング。全体のずれ＝lag は差し引く）-------
  let rhythm = 0;
  if (refNotes.length) {
    let sum = 0;
    for (const note of refNotes) {
      const target = note.t0 + lag;
      let best = null;
      for (const u of U.notes) {
        const dt = u.t0 - target;
        if (Math.abs(dt) <= 0.35 && (best === null || Math.abs(dt) < Math.abs(best))) best = dt;
      }
      if (best !== null) sum += clamp(1 - Math.abs(best) / 0.2, 0, 1);
    }
    rhythm = sum / refNotes.length;
  }

  // --- 表現 ------------------------------------------------------
  const LABEL = { kob: "こぶし", sak: "しゃくり", vib: "ビブラート", fal: "フォール" };
  const expr = {};
  const hitsIn = (type, t0, t1) =>
    U.events.some((u) => u.type === type && u.t1 >= t0 + lag - 0.15 && u.t0 <= t1 + lag + 0.15);
  for (const type of ["kob", "sak", "fal"]) {
    const ref = R.events.filter((e) => e.type === type);
    if (!ref.length) continue; // お手本に無ければ判定しない
    const hit = ref.filter((e) => hitsIn(type, e.t0, e.t1)).length;
    expr[type] = { ratio: hit / ref.length, hit, total: ref.length };
  }
  // ビブラートは「0.6秒以上伸ばした音」で必ず判定する
  const sustained = refNotes.filter((n) => n.dur >= 0.6);
  if (sustained.length) {
    const hit = sustained.filter((n) => hitsIn("vib", n.t0, n.t1)).length;
    expr.vib = { ratio: hit / sustained.length, hit, total: sustained.length };
  }
  const exKeys = Object.keys(expr);
  const exprScore = exKeys.length
    ? exKeys.reduce((s, k) => s + expr[k].ratio, 0) / exKeys.length
    : null;

  // --- 総合（音程55・リズム15・表現30）-------------------------------
  const total = exprScore === null
    ? (0.55 * pitch + 0.15 * rhythm) / 0.7
    : 0.55 * pitch + 0.15 * rhythm + 0.3 * exprScore;
  const value = Math.round(total * 1000) / 10;

  return {
    value,
    rank: rankOf(value),
    stars: Math.min(5, Math.floor(value / 20)),
    lag: Math.round(lag * 1000),
    pitch: Math.round(pitch * 1000) / 10,
    rhythm: Math.round(rhythm * 1000) / 10,
    expr: exprScore === null ? null : Math.round(exprScore * 1000) / 10,
    exprDetail: Object.fromEntries(Object.entries(expr).map(([k, v]) => [k, {
      label: LABEL[k], hit: v.hit, total: v.total, pct: Math.round(v.ratio * 100),
    }])),
    low, high, miss,
    notes: noteResults,
    comments: makeComments({ pitch, rhythm, exprScore, low, high, miss, n: refNotes.length, expr, LABEL }),
  };
}

export function rankOf(v) {
  if (v >= 95) return "S";
  if (v >= 85) return "A";
  if (v >= 70) return "B";
  if (v >= 50) return "C";
  return "D";
}

function makeComments({ pitch, rhythm, exprScore, low, high, miss, n, expr, LABEL }) {
  const out = [];
  if (pitch >= 0.9) out.push("音程はほぼ正確です。見事！");
  else if (pitch < 0.5) out.push("音程のズレが目立ちます。まずは旋律を正確に追いましょう。");
  if (pitch < 0.9 && low > high * 2 && low >= 2) out.push("全体的に低めに外れる傾向があります。");
  else if (pitch < 0.9 && high > low * 2 && high >= 2) out.push("全体的に高めに外れる傾向があります。");
  if (miss >= Math.max(2, n * 0.3)) out.push(`取れていない音が ${miss} 箇所あります。`);
  if (rhythm < 0.6) out.push("音の出だしのタイミングがずれています。");
  for (const k of ["kob", "sak", "vib", "fal"]) {
    const e = expr[k];
    if (!e) continue;
    if (e.ratio >= 0.8) out.push(`${LABEL[k]}が上手に決まっています。`);
    else if (e.ratio < 0.4) out.push(`${LABEL[k]}が少なめです（${e.hit}/${e.total}）。`);
  }
  if (!out.length) out.push("いい感じです。次はもっと表情をつけてみましょう。");
  return out;
}
