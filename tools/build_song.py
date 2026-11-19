#!/usr/bin/env python3
"""
曲フォルダから、サイトで使うデータ（お手本のピッチ列・再生用mp3・曲一覧）を作ります。

  songs/<曲ID>/source.wav   原曲（お手本の旋律をここから解析する）
  songs/<曲ID>/backing.wav  カラオケ用の伴奏（歌なし）。無ければ原曲を再生する
  （どちらも .mp3 / .m4a / .flac / .ogg でも可。source.* は必須）
  python tools/build_song.py            # 全曲を処理（既に最新なら飛ばす）
  python tools/build_song.py --force    # 全曲を作り直す
  python tools/build_song.py songs/xxx  # 指定の曲だけ

出力（曲フォルダ内）:
  audio.mp3   再生用（backing があればそれ、無ければ原曲）
  ref.json    お手本のピッチ列（10msごとのMIDIノート番号。null は無声）
  meta.json   曲名・歌詞など（無ければ雛形を作る。編集してOK）
songs/index.json は全曲から再生成されます。
"""
import sys, json, shutil, subprocess, pathlib
import numpy as np
import librosa
from scipy.ndimage import median_filter

ROOT = pathlib.Path(__file__).resolve().parent.parent
SONGS = ROOT / "songs"
SR = 22050
HOP = 220          # 22050Hz で 220サンプル = 10ms
FMIN, FMAX = 180.0, 850.0   # リード旋律の想定音域（ベース等の低音を除外）
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".flac", ".ogg"}


def extract_melody(y):
    """和音・ドラム・ベースが重なった音源から、リード旋律の音程列を推定する。
    倍音和（基音を重視）＋ベースの1オクターブ下の誤検出を抑える＋ビタビ平滑化。
    返り値: 10msごとのMIDIノート番号（無声は NaN）"""
    nfft = 4096
    S = np.abs(librosa.stft(y, n_fft=nfft, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=nfft)
    M = np.log1p(S / (S.max(axis=0, keepdims=True) + 1e-9) * 20.0)

    cand = FMIN * 2 ** (np.arange(int(np.ceil(np.log2(FMAX / FMIN) * 60))) / 60.0)
    harm = [(1, 1.0), (2, 0.7), (3, 0.5), (4, 0.35), (5, 0.25), (6, 0.2)]

    def sample(f):
        idx = np.interp(f, freqs, np.arange(len(freqs)))
        lo = np.floor(idx).astype(int)
        fr = idx - lo
        hi = np.minimum(lo + 1, len(freqs) - 1)
        return M[lo] * (1 - fr)[:, None] + M[hi] * fr[:, None]

    sal = np.zeros((len(cand), M.shape[1]))
    for h, w in harm:
        sal += w * sample(cand * h)
    sal -= 0.5 * sample(cand / 2)          # 1オクターブ下（ベース）への誤認を抑える

    # ビタビ（隣接フレームで音程が飛ぶほど罰点）
    K, T = sal.shape
    jp = 0.15
    dp = sal[:, 0].copy()
    back = np.zeros((K, T), dtype=np.int32)
    kk = np.arange(K)
    for t in range(1, T):
        best = dp.copy()
        arg = kk.copy()
        for i in range(1, K):
            c = best[i - 1] - jp
            if c > best[i]:
                best[i] = c; arg[i] = arg[i - 1]
        for i in range(K - 2, -1, -1):
            c = best[i + 1] - jp
            if c > best[i]:
                best[i] = c; arg[i] = arg[i + 1]
        dp = best + sal[:, t]
        back[:, t] = arg
    path = np.zeros(T, dtype=int)
    path[-1] = int(np.argmax(dp))
    for t in range(T - 1, 0, -1):
        path[t - 1] = back[path[t], t]

    f = cand[path]
    conf = sal[path, np.arange(T)]
    voiced = conf > np.percentile(conf, 35)
    midi = librosa.hz_to_midi(f)
    midi = median_filter(midi, size=5)
    # 短すぎる有声区間（ノイズ）を消す
    run_start = None
    for i in range(T + 1):
        v = voiced[i] if i < T else False
        if v and run_start is None:
            run_start = i
        elif not v and run_start is not None:
            if i - run_start < 6:
                voiced[run_start:i] = False
            run_start = None
    return np.where(voiced, midi, np.nan)


def find_source(d, stem="source"):
    for p in sorted(d.glob(stem + ".*")):
        if p.suffix.lower() in AUDIO_EXT:
            return p
    if stem == "source":
        wavs = sorted(d.glob("*.wav"))
        return wavs[0] if wavs else None
    return None


def write_audio(src, d):
    """再生用に mp3 を作る。ffmpeg が無ければ元ファイルをそのままコピー。"""
    out = d / "audio.mp3"
    try:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                        "-codec:a", "libmp3lame", "-b:a", "160k", str(out)], check=True)
        return out.name
    except (OSError, subprocess.CalledProcessError):
        dst = d / ("audio" + src.suffix.lower())
        shutil.copyfile(src, dst)
        return dst.name


def build_one(d, force=False):
    src = find_source(d)
    if src is None:
        return None
    backing = find_source(d, "backing")
    ref = d / "ref.json"
    newest = max(p.stat().st_mtime for p in [src] + ([backing] if backing else []))
    if (not force and ref.exists() and (d / "audio.mp3").exists()
            and ref.stat().st_mtime >= newest):
        print(f"skip  {d.name} (最新)")
        return d.name
    meta_p = d / "meta.json"
    meta = json.loads(meta_p.read_text(encoding="utf-8")) if meta_p.exists() else {}
    meta.setdefault("title", d.name)
    meta.setdefault("artist", "")
    meta.setdefault("lyrics", [])          # 例: [{"t": 3.5, "text": "歌詞の一行"}]
    meta["id"] = d.name

    print(f"build {d.name} <- {src.name}")
    y, _ = librosa.load(src, sr=SR, mono=True)
    midi = extract_melody(y)
    dur = len(y) / SR
    vals = [None if np.isnan(v) else round(float(v), 2) for v in midi]
    ref.write_text(json.dumps({"hop_ms": 10, "duration": round(dur, 3), "midi": vals},
                              separators=(",", ":")), encoding="utf-8")
    meta["audio"] = write_audio(backing or src, d)
    meta["backing"] = bool(backing)
    meta["duration"] = round(dur, 2)
    meta_p.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    voiced = sum(v is not None for v in vals)
    print(f"      duration {dur:.1f}s, voiced {voiced}/{len(vals)} frames")
    return d.name


def write_index():
    items = []
    for d in sorted(SONGS.iterdir()):
        m = d / "meta.json"
        if d.is_dir() and m.exists() and (d / "ref.json").exists():
            meta = json.loads(m.read_text(encoding="utf-8"))
            items.append({"id": d.name, "title": meta.get("title", d.name),
                          "artist": meta.get("artist", ""),
                          "duration": meta.get("duration", 0),
                          "dir": f"songs/{d.name}"})
    (SONGS / "index.json").write_text(json.dumps(items, ensure_ascii=False, indent=2),
                                      encoding="utf-8")
    print(f"songs/index.json: {len(items)} 曲")


def main(argv):
    force = "--force" in argv
    args = [pathlib.Path(a) for a in argv if not a.startswith("--")]
    dirs = [ROOT / a if not a.is_absolute() else a for a in args] or \
           [d for d in sorted(SONGS.iterdir()) if d.is_dir()]
    for d in dirs:
        build_one(d, force=force)
    write_index()


if __name__ == "__main__":
    main(sys.argv[1:])
