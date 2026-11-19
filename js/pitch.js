// ブラウザ用のピッチ検出（YIN法）と音名変換
export const HOP = 0.01; // 採点データは10msごと

// buf: 直近のマイク波形（Float32Array, 長さ2048 推奨）
// 戻り値: { freq, ap, rms }  ap は非周期性（小さいほど澄んだ音）
export function yin(buf, sr) {
  const W = 1024;
  const N = buf.length;
  const TAU_MIN = Math.floor(sr / 1000);
  const TAU_MAX = Math.min(Math.floor(sr / 70), N - W - 1);
  const base = N - W - TAU_MAX;
  if (base < 0) return null;

  let energy = 0;
  for (let j = N - W; j < N; j++) energy += buf[j] * buf[j];
  const rms = Math.sqrt(energy / W);
  if (rms < 0.006) return { freq: 0, ap: 1, rms };

  const d = new Float32Array(TAU_MAX + 1);
  for (let tau = 1; tau <= TAU_MAX; tau++) {
    let s = 0;
    for (let j = 0; j < W; j++) {
      const k = buf[base + j] - buf[base + j + tau];
      s += k * k;
    }
    d[tau] = s;
  }
  // 累積平均正規化差分
  const dn = new Float32Array(TAU_MAX + 1);
  dn[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= TAU_MAX; tau++) {
    run += d[tau];
    dn[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  // 閾値 0.15 を初めて下回る谷を採用
  let tau = -1;
  for (let t = TAU_MIN; t < TAU_MAX; t++) {
    if (dn[t] < 0.15) {
      while (t + 1 < TAU_MAX && dn[t + 1] < dn[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    tau = TAU_MIN;
    for (let t = TAU_MIN; t < TAU_MAX; t++) if (dn[t] < dn[tau]) tau = t;
  }
  // 放物線補間で精度を上げる
  let x = tau;
  if (tau > 0 && tau < TAU_MAX) {
    const s0 = dn[tau - 1], s1 = dn[tau], s2 = dn[tau + 1];
    const den = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(den) > 1e-9) x = tau + (s2 - s0) / den;
  }
  return { freq: sr / x, ap: dn[tau], rms };
}

export function freqToMidi(f) {
  return 69 + 12 * Math.log2(f / 440);
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export function midiName(m) {
  const n = Math.round(m);
  return NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

// 半音単位の差を -6..6 に折りたたむ（オクターブ違いは許容）
export function wrapOct(x) {
  let v = ((x % 12) + 12) % 12;
  if (v > 6) v -= 12;
  return v;
}
