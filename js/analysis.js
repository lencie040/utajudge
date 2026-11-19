// お手本とユーザー歌唱で共通に使う解析：音（有声区間）と、こぶし・しゃくり・ビブラート・フォールの検出
import { HOP } from "./pitch.js";

const median = (arr) => {
  const a = Array.from(arr).filter((v) => !Number.isNaN(v)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
export { median };

// 中央値フィルタ（窓は奇数フレーム、端は窓を縮める）
function movingMedian(arr, win) {
  const n = arr.length, h = win >> 1, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n, i + h + 1);
    out[i] = median(arr.slice(a, b));
  }
  return out;
}

// 有声区間を探す。短い無声の隙間（70ms以下）は同じ音として繋ぐ
export function findRuns(midi, minFrames = 10, maxGap = 7) {
  const runs = [];
  let i = 0;
  const n = midi.length;
  while (i < n) {
    if (Number.isNaN(midi[i])) { i++; continue; }
    let i0 = i, last = i;
    let j = i + 1;
    while (j < n) {
      if (!Number.isNaN(midi[j])) { last = j; j++; continue; }
      if (j - last > maxGap) break;
      j++;
    }
    if (last - i0 + 1 >= minFrames) runs.push({ i0, i1: last + 1 });
    i = last + 1;
  }
  return runs;
}

// 区間内の音程（半音）。無声の穴は線形補間し、3フレームの中央値で平滑化
function runContour(midi, i0, i1) {
  const n = i1 - i0;
  const c = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    c[k] = midi[i0 + k];
  }
  // 穴埋め
  for (let k = 0; k < n; k++) {
    if (!Number.isNaN(c[k])) continue;
    let a = k - 1; while (a >= 0 && Number.isNaN(c[a])) a--;
    let b = k + 1; while (b < n && Number.isNaN(c[b])) b++;
    if (a >= 0 && b < n) c[k] = c[a] + ((c[b] - c[a]) * (k - a)) / (b - a);
    else if (a >= 0) c[k] = c[a];
    else if (b < n) c[k] = c[b];
  }
  return movingMedian(c, 3);
}

// 音（有声区間）と、ornament イベントを解析する
// 戻り値: { notes: [{t0,t1,dur,base}], events: [{type:'vib'|'kob'|'sak'|'fal', t0,t1}] }
export function analyze(midi) {
  const notes = [], events = [];
  for (const r of findRuns(midi)) {
    const c = runContour(midi, r.i0, r.i1);
    const n = c.length;
    const t0 = r.i0 * HOP, t1 = r.i1 * HOP;
    const base = median(c);
    notes.push({ t0, t1, dur: t1 - t0, base });
    if (n < 10) continue;

    // d = 0.8秒の移動中央値からのずれ（ビブラート・こぶしの検出用）
    const ms = movingMedian(c, 81);
    const d = c.map((v, i) => v - ms[i]);

    // --- ビブラート：0.5秒の窓で、周期 3.5〜9Hz・深さ 30〜150セント
    const vib = new Uint8Array(n);
    const VW = 50;
    if (n >= VW) {
      for (let s = 0; s + VW <= n; s += 5) {
        let zc = 0, ss = 0;
        for (let k = s; k < s + VW; k++) {
          ss += d[k] * d[k];
          if (k > s && d[k] * d[k - 1] < 0) zc++;
        }
        const rate = zc / 2 / (VW * HOP);
        const amp = Math.sqrt((2 * ss) / VW);
        if (rate >= 3.5 && rate <= 9 && amp >= 0.3 && amp <= 1.5) {
          for (let k = s; k < s + VW; k++) vib[k] = 1;
        }
      }
      // 0.4秒以上続いたものだけ採用
      let k = 0;
      while (k < n) {
        if (!vib[k]) { k++; continue; }
        let e = k; while (e < n && vib[e]) e++;
        if (e - k >= 40) events.push({ type: "vib", t0: t0 + k * HOP, t1: t0 + e * HOP });
        k = e;
      }
    }

    // --- しゃくり：音の立ち上がりで、下から 1〜4.5半音 上がってくる
    let sakEnd = 0;
    if (n >= 40) {
      const start = median(c.slice(0, 8));
      const tgt = median(c.slice(25, 45));
      const rise = tgt - start;
      if (rise >= 1.0 && rise <= 4.5) {
        events.push({ type: "sak", t0, t1: t0 + 0.45 });
        sakEnd = 45;
      }
    }

    // --- フォール：音の終わりで、1〜4.5半音 下がる
    let falStart = n;
    const wf = Math.min(n, 50);
    if (wf >= 20) {
      const head = median(c.slice(n - wf, n - wf + Math.floor(wf / 3)));
      const tail = median(c.slice(n - 8));
      const drop = head - tail;
      if (drop >= 1.0 && drop <= 4.5) {
        events.push({ type: "fal", t0: t1 - wf * HOP, t1 });
        falStart = n - wf;
      }
    }

    // --- こぶし：音の中で、±0.6半音以上の揺れが 80〜450ms 続き、元に戻る
    //     （ビブラート、立ち上がり、フォールの区間は除く）
    let k = 15;
    while (k < n - 15) {
      const inZone = (x) => vib[x] || x < sakEnd || x >= falStart;
      if (inZone(k) || Math.abs(d[k]) < 0.6) { k++; continue; }
      const sign = Math.sign(d[k]);
      let e = k;
      while (e < n && !inZone(e) && Math.sign(d[e]) === sign && Math.abs(d[e]) >= 0.4) e++;
      const len = e - k;
      if (len >= 8 && len <= 45) events.push({ type: "kob", t0: t0 + k * HOP, t1: t0 + e * HOP });
      k = Math.max(e, k + 1);
    }
  }
  return { notes, events };
}
