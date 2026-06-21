#!/usr/bin/env python3
"""
Phase-3 librosa blind cross-check — audio verification.

独立性の質の区別（README §"独立性の質を正直に書き分ける" 参照）:
  onset : アルゴリズム独立 — librosa は spectral-flux peak-picking (onset_detect)、
          Rust は threshold-based zero-crossing 検出。別アルゴリズムなので真の差分検証。
  level : 実装独立 — どちらも sqrt(mean(x²)) だが librosa は独自フレーミングで計算。
          配管バグ（channel stride / 窓境界 / dtype）を捕まえる。
          「RMS の数学を独立に再導出した」とは主張しない。
  pan   : 実装独立 — librosa の per-ch RMS から等パワー逆算（atan2 は Rust と共有の純粋数学）。
          各 ch RMS が一致することで atan2 への入力の健全性を確認する。
          atan2 の数学は analysis.rs のアンカーテストで別途 pin 済み。

Rust の pan_from_lr_rms(l, r) と同じ式:
  angle  = atan2(r_rms, l_rms)   # [0, π/2]
  pan01  = angle / (π/2)
  pan    = clamp(2*pan01 - 1, -1, 1)
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from pathlib import Path
from typing import Any

import librosa
import librosa.feature
import librosa.onset
import numpy as np

# ---------------------------------------------------------------------------
# 許容（README §許容 と同値）
# ---------------------------------------------------------------------------
LEVEL_REL_TOL = 0.03        # RMS 相対誤差 ≤ 3%
PAN_TOL = 0.05              # pan 単位 ±0.05
ONSET_OURS_FRAMES = 96      # ours ↔ scheduled: ±2ms @48kHz = 96 frames
ONSET_LIBROSA_FRAMES = 720  # librosa ↔ scheduled: ±15ms @48kHz = 720 frames

FIXTURES = ["per_event_gain", "pan_three_voices", "chop_region"]


# ---------------------------------------------------------------------------
# PCM 読み込み
# ---------------------------------------------------------------------------

def read_pcm(pcm_path: Path, channels: int) -> np.ndarray:
    """生 PCM（LE interleaved f32）を (frames, channels) の ndarray で返す。

    PCM が存在しない場合は明確なエラーメッセージで終了する。
    """
    if not pcm_path.exists():
        print(
            f"[ERROR] PCM ファイルが見つかりません: {pcm_path}\n"
            "先に以下を実行して生 PCM を生成してください:\n"
            "  cargo run -p orbit-audio-daemon --example export_verify_pcm",
            file=sys.stderr,
        )
        sys.exit(2)
    raw = np.fromfile(str(pcm_path), dtype="<f4")
    return raw.reshape(-1, channels)


# ---------------------------------------------------------------------------
# level 測定 (実装独立)
# ---------------------------------------------------------------------------

def measure_level_librosa(y: np.ndarray, start: int, end: int) -> float:
    """bodyWindow [start, end) の 1ch 配列を librosa feature.rms で測定する。

    Rust の region_rms は bodyWindow 全体を単一の sqrt(mean(x²)) で測る（スカラー）。
    librosa feature.rms も同じ窓全体を単一フレームとして測るため、
    frame_length = len(region) を明示して 1 フレームに縮退させる。

    デフォルト (frame_length=2048) では窓が複数フレームに分割され、
    kick のような減衰信号では ~30% の系統的ズレが生じる。
    frame_length を窓長にそろえると librosa の内部ループ・dtype キャスト・
    正規化コードを通るため「実装独立」の性質は保たれる。
    Rust が補足しない overlap 設定やウィンドウ関数の差があればこのチェックで露出する。
    """
    region = y[start:end]
    n = region.size
    if n == 0:
        return 0.0
    # frame_length = 窓全体で librosa の単一フレーム RMS を計算
    rms_frames = librosa.feature.rms(
        y=region, frame_length=n, hop_length=n, center=False
    )[0]
    return float(rms_frames[0])


# ---------------------------------------------------------------------------
# pan 測定 (実装独立)
# ---------------------------------------------------------------------------

def pan_from_lr_rms_python(l_rms: float, r_rms: float) -> float:
    """Rust の pan_from_lr_rms と同じ式でパン位置を逆算する。

    Rust analysis.rs:
      angle  = atan2(r_rms, l_rms)  -- [0, π/2]
      pan01  = angle / (π/2)
      pan    = clamp(2*pan01 - 1, -1, 1)

    この数学は Rust と共有（純粋数学）。実装独立の質は
    「atan2 への入力（per-ch RMS）が librosa で一致するか」にある。
    """
    angle = math.atan2(r_rms, l_rms)
    pan01 = angle / (math.pi / 2)
    return max(-1.0, min(1.0, 2.0 * pan01 - 1.0))


# ---------------------------------------------------------------------------
# onset 測定 (アルゴリズム独立)
# ---------------------------------------------------------------------------

def detect_onsets_librosa(mono: np.ndarray, sr: int) -> np.ndarray:
    """mono 配列に librosa.onset.onset_detect を適用してサンプル位置を返す。

    Rust は threshold-based 手法（body peak の比率）、librosa は spectral-flux
    peak-picking — 別アルゴリズムなので「アルゴリズム独立」の比較が成立する。
    backtrack=True でサンプル位置を onset の立ち上がりに近づける。
    """
    frames = librosa.onset.onset_detect(
        y=mono.astype(np.float32),
        sr=sr,
        units="samples",
        backtrack=True,
    )
    return np.asarray(frames, dtype=np.int64)


# ---------------------------------------------------------------------------
# 比較ロジック
# ---------------------------------------------------------------------------

def compare_event(
    event: dict[str, Any],
    pcm: np.ndarray,
    sr: int,
    librosa_onsets: np.ndarray,
) -> dict[str, Any]:
    """1 イベントの level / pan / onset を比較し、結果 dict を返す。"""
    ch = pcm.shape[1]
    start, end = event["bodyWindow"]

    # -- level (各 ch, 実装独立) --
    l_lib = measure_level_librosa(pcm[:, 0], start, end)
    r_lib = measure_level_librosa(pcm[:, 1], start, end) if ch > 1 else l_lib

    l_rust = event["lRms"]
    r_rust = event["rRms"]

    # 相対誤差。分母は 1e-6（≈ −120 dBFS）で floor し、無音 ch（denormal 振幅）での
    # platform 依存の偽 FAIL を避ける（subnormal を片側だけ flush して比が暴れるのを防ぐ）。
    l_rel_err = abs(l_lib - l_rust) / max(l_rust, 1e-6)
    r_rel_err = abs(r_lib - r_rust) / max(r_rust, 1e-6)
    level_ok = l_rel_err <= LEVEL_REL_TOL and r_rel_err <= LEVEL_REL_TOL

    # -- pan (実装独立: per-ch RMS から逆算) --
    pan_lib = pan_from_lr_rms_python(l_lib, r_lib)
    pan_rust = event["pan"]
    pan_delta = pan_lib - pan_rust
    pan_ok = abs(pan_delta) <= PAN_TOL

    # -- onset (アルゴリズム独立, 3-way) --
    scheduled = event["onsetFrameScheduled"]
    ours = event["onsetFrameThreshold"]

    # ours（threshold 法）↔ scheduled。検出失敗（null）は FAIL として扱う（不能を緑にしない）。
    if ours is None:
        delta_ours_vs_scheduled = None
        ours_ok = False
    else:
        delta_ours_vs_scheduled = ours - scheduled
        ours_ok = abs(delta_ours_vs_scheduled) <= ONSET_OURS_FRAMES

    # matched filter 法（onsetFrameMatched が出力されたイベントのみ）↔ scheduled。
    # detect_onset_matched プリミティブを scheduled 真値に対して grounding する
    # （librosa オラクルではなく Rust 別プリミティブ vs 真値の整合確認）。
    matched = event.get("onsetFrameMatched")
    if matched is None:
        delta_matched_vs_scheduled = None
        matched_ok = True  # 当該イベントで未測定 = 制約なし
    else:
        delta_matched_vs_scheduled = matched - scheduled
        matched_ok = abs(delta_matched_vs_scheduled) <= ONSET_OURS_FRAMES

    # scheduled に最近接の librosa 検出を探す（scheduled → 最近接 librosa の向き）
    if librosa_onsets.size > 0:
        diffs = np.abs(librosa_onsets - scheduled)
        nearest_lib = int(librosa_onsets[int(np.argmin(diffs))])
        delta_ours_vs_librosa = None if ours is None else ours - nearest_lib
        delta_lib_vs_scheduled = nearest_lib - scheduled
        librosa_matched = abs(delta_lib_vs_scheduled) <= ONSET_LIBROSA_FRAMES
    else:
        nearest_lib = None
        delta_ours_vs_librosa = None
        delta_lib_vs_scheduled = None
        librosa_matched = False

    onset_ok = ours_ok and matched_ok and librosa_matched

    return {
        "sequenceName": event.get("sequenceName"),
        "level": {
            "lRms_rust": l_rust,
            "lRms_librosa": round(l_lib, 6),
            "lRelErr": round(l_rel_err, 6),
            "rRms_rust": r_rust,
            "rRms_librosa": round(r_lib, 6),
            "rRelErr": round(r_rel_err, 6),
            "tolerance": LEVEL_REL_TOL,
            "withinTolerance": level_ok,
            "note": "実装独立: librosa feature.rms(frame_length=窓全体) vs Rust region_rms。overlap/dtype/正規化の実装差を検証する",
        },
        "pan": {
            "pan_rust": pan_rust,
            "pan_librosa": round(pan_lib, 6),
            "delta": round(pan_delta, 6),
            "tolerance": PAN_TOL,
            "withinTolerance": pan_ok,
            "note": (
                "実装独立: per-ch RMS の一致を確認（atan2 の数学は Rust と共有=純粋数学）。"
                "atan2 の正しさは analysis.rs のアンカーテストで別途 pin 済み"
            ),
        },
        "onset": {
            "scheduled": scheduled,
            "ours_onsetFrameThreshold": ours,
            "matched_onsetFrameMatched": matched,
            "librosa_nearest": nearest_lib,
            "deltaOursVsScheduled": delta_ours_vs_scheduled,
            "deltaMatchedVsScheduled": delta_matched_vs_scheduled,
            "deltaOursVsLibrosa": delta_ours_vs_librosa,
            "deltaLibrosaVsScheduled": delta_lib_vs_scheduled,
            "toleranceOursVsScheduled_frames": ONSET_OURS_FRAMES,
            "toleranceLibrosaVsScheduled_frames": ONSET_LIBROSA_FRAMES,
            "oursWithinTolerance": ours_ok,
            "matchedWithinTolerance": matched_ok,
            "librosaMatched": librosa_matched,
            "withinTolerance": onset_ok,
            "note": "アルゴリズム独立: librosa=spectral-flux vs Rust threshold。matched は scheduled 真値と整合確認",
        },
        "eventOk": level_ok and pan_ok and onset_ok,
    }


def run_fixture(
    fixture_name: str,
    fixtures_dir: Path,
    out_dir: Path,
    python_ver: str,
) -> bool:
    """1 フィクスチャを処理して比較 JSON を書き出す。ok なら True を返す。"""
    rust_json_path = fixtures_dir / f"{fixture_name}.rust.json"
    if not rust_json_path.exists():
        print(
            f"[ERROR] Rust 測定 JSON が見つかりません: {rust_json_path}\n"
            "先に以下を実行してください:\n"
            "  cargo run -p orbit-audio-daemon --example export_verify_pcm",
            file=sys.stderr,
        )
        sys.exit(2)

    with open(rust_json_path) as f:
        rust = json.load(f)

    # .gen/ は rust.json と同じ verify-fixtures/phase3/ を基底にした相対パス
    pcm_rel = rust["pcmFile"]  # 例: ".gen/per_event_gain.pcm"
    pcm_path = fixtures_dir / pcm_rel
    channels = rust["channels"]
    sr = rust["sampleRate"]

    pcm = read_pcm(pcm_path, channels)
    # PCM frame 数を rust.json の期待値と照合（stale/truncated PCM を静かに通さない）。
    if pcm.shape[0] != rust["frames"]:
        print(
            f"[ERROR] PCM フレーム数不一致: {pcm_path} は {pcm.shape[0]} frames、"
            f"rust.json は {rust['frames']} frames を期待。PCM を再生成してください:\n"
            "  cargo run -p orbit-audio-daemon --example export_verify_pcm",
            file=sys.stderr,
        )
        sys.exit(2)

    # mono mix (L+R)/2 — Rust と同じ定義
    mono = pcm.mean(axis=1).astype(np.float32)

    # librosa onset 検出（mono 全体）
    librosa_onsets = detect_onsets_librosa(mono, sr)

    event_results = []
    all_ok = True
    for ev in rust["events"]:
        result = compare_event(ev, pcm, sr, librosa_onsets)
        event_results.append(result)
        if not result["eventOk"]:
            all_ok = False

    # spurious onset 件数（全 scheduled onset にマッチしなかった librosa 検出）。
    # 各 librosa 検出について最近接 scheduled までの距離をベクトルで出し、許容超過を数える。
    scheduled_positions = np.array(
        [ev["onsetFrameScheduled"] for ev in rust["events"]], dtype=np.int64
    )
    nearest_dist = np.abs(librosa_onsets[:, None] - scheduled_positions[None, :]).min(axis=1)
    spurious_count = int(np.sum(nearest_dist > ONSET_LIBROSA_FRAMES))

    compare = {
        "fixture": fixture_name,
        "pythonVersion": python_ver,
        "librosaVersion": librosa.__version__,
        "numpyVersion": np.__version__,
        "tolerances": {
            "levelRelTol": LEVEL_REL_TOL,
            "panTol": PAN_TOL,
            "onsetOursVsScheduled_frames": ONSET_OURS_FRAMES,
            "onsetLibrosaVsScheduled_frames": ONSET_LIBROSA_FRAMES,
        },
        "librosaOnsetCount": int(librosa_onsets.size),
        "spuriousOnsetCount": spurious_count,
        "events": event_results,
        "verdict": "PASS" if all_ok else "FAIL",
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{fixture_name}.compare.json"
    with open(out_path, "w") as f:
        json.dump(compare, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"  [{compare['verdict']}] {fixture_name} → {out_path}")
    if not all_ok:
        for ev_r in event_results:
            if not ev_r["eventOk"]:
                name = ev_r["sequenceName"]
                lv = ev_r["level"]
                pn = ev_r["pan"]
                on = ev_r["onset"]
                if not lv["withinTolerance"]:
                    print(
                        f"    LEVEL FAIL [{name}]: "
                        f"lRelErr={lv['lRelErr']:.4f} rRelErr={lv['rRelErr']:.4f} "
                        f"(tol={LEVEL_REL_TOL})",
                        file=sys.stderr,
                    )
                if not pn["withinTolerance"]:
                    print(
                        f"    PAN FAIL [{name}]: delta={pn['delta']:.4f} "
                        f"(tol±{PAN_TOL})",
                        file=sys.stderr,
                    )
                if not on["withinTolerance"]:
                    print(
                        f"    ONSET FAIL [{name}]: "
                        f"oursVsScheduled={on['deltaOursVsScheduled']} "
                        f"(tol±{ONSET_OURS_FRAMES}fr), "
                        f"libVsScheduled={on['deltaLibrosaVsScheduled']} "
                        f"(tol±{ONSET_LIBROSA_FRAMES}fr)",
                        file=sys.stderr,
                    )
    return all_ok


# ---------------------------------------------------------------------------
# self-test（合成 PCM）
# ---------------------------------------------------------------------------

def run_selftest(phase3_dir: Path, python_ver: str) -> None:
    """合成 PCM でスクリプトのロジック（正常系・異常系）を自己検証する。

    生成物は .gen/_selftest.pcm と _selftest.compare.json（いずれも gitignore 対象）。
    合成 PCM を `read_pcm` / `compare_event` / `run_fixture` と同じ本番コードパスで処理する。
    """
    print("[selftest] 合成 PCM を生成して self-test を実行...")

    # 合成パラメータ
    sr = 48000
    channels = 2
    silence_frames = 4800        # 0.1 s 無音
    burst_frames = 12000         # 0.25 s バースト（librosa デフォルト frame_length=2048 より
                                 # 十分に長い窓を確保し、frame_length=len(region) の
                                 # 単一フレーム収束を回帰ガードとして通過させる）
    gap_frames = 48000 * 2       # 2 s の間隔
    tail_frames = 4800           # 末尾の無音

    total_frames = silence_frames + burst_frames + gap_frames + burst_frames + tail_frames

    pcm = np.zeros((total_frames, channels), dtype=np.float32)

    # burst 1: broadband attenuating noise（center pan, 振幅 0.5）
    b1_start = silence_frames
    b1_end = b1_start + burst_frames
    rng = np.random.default_rng(42)
    env1 = np.linspace(0.5, 0.01, burst_frames, dtype=np.float32)
    noise1 = (rng.standard_normal(burst_frames) * env1).astype(np.float32)
    pcm[b1_start:b1_end, 0] = noise1
    pcm[b1_start:b1_end, 1] = noise1  # center: L=R

    # burst 2: -6dB（= L channel のみ、半分のゲイン）
    b2_start = silence_frames + burst_frames + gap_frames
    b2_end = b2_start + burst_frames
    env2 = np.linspace(0.25, 0.005, burst_frames, dtype=np.float32)
    noise2 = (rng.standard_normal(burst_frames) * env2).astype(np.float32)
    pcm[b2_start:b2_end, 0] = noise2
    pcm[b2_start:b2_end, 1] = noise2

    # spurious burst（scheduled に対応しない onset — spurious カウントのテスト）
    sp_start = silence_frames + burst_frames + gap_frames // 2
    sp_end = sp_start + 480
    noise_sp = (rng.standard_normal(sp_end - sp_start) * 0.3).astype(np.float32)
    pcm[sp_start:sp_end, 0] = noise_sp
    pcm[sp_start:sp_end, 1] = noise_sp

    # .gen/ に保存（phase3_dir は tests/audio/verify/phase3/ なので parents[3] = project root）
    project_root = phase3_dir.parents[3]
    gen_dir = project_root / "test-assets" / "verify-fixtures" / "phase3" / ".gen"
    gen_dir.mkdir(parents=True, exist_ok=True)
    pcm_path = gen_dir / "_selftest.pcm"
    pcm.astype("<f4").tofile(str(pcm_path))

    # body windows（burst のほぼ全域を使う）。256/64 は Rust body_window と意味的に対応させた
    # 任意値（selftest は合成 PCM なので Rust 定数との完全一致は不要）。
    b1_body = [b1_start + 256, b1_end - 64]
    b2_body = [b2_start + 256, b2_end - 64]

    # 参照 RMS（Rust と同じ定義 sqrt(mean(x²))。measure_level_librosa は使わない＝比較対象だから）。
    def _rms(arr: np.ndarray) -> float:
        return float(np.sqrt(np.mean(arr ** 2)))

    b1_l_rms = _rms(pcm[b1_body[0]:b1_body[1], 0])
    b1_r_rms = _rms(pcm[b1_body[0]:b1_body[1], 1])
    b2_l_rms = _rms(pcm[b2_body[0]:b2_body[1], 0])
    b2_r_rms = _rms(pcm[b2_body[0]:b2_body[1], 1])

    b1_pan = pan_from_lr_rms_python(b1_l_rms, b1_r_rms)
    b2_pan = pan_from_lr_rms_python(b2_l_rms, b2_r_rms)

    def make_rust_dict(l_rms, r_rms, pan_val, onset, body, name):
        return {
            "sequenceName": name,
            "onsetSec": onset / sr,
            "onsetFrameScheduled": onset,
            "onsetFrameThreshold": onset + 10,  # 10 frames ≈ 0.2ms ずれ（許容内）
            "onsetFrameMatched": None,
            "bodyWindow": body,
            "lRms": l_rms,
            "rRms": r_rms,
            # 合成近似。compare_event は monoRms を参照しないため無害（厳密値は rms((L+R)/2)）。
            "monoRms": (l_rms + r_rms) / 2,
            "pan": pan_val,
            "gainDb": -3.0,
        }

    rust_normal = {
        "fixture": "_selftest",
        "sampleRate": sr,
        "channels": channels,
        "frames": total_frames,
        "pcmFile": ".gen/_selftest.pcm",
        "onsetThresholdRatio": 0.3,
        "events": [
            make_rust_dict(b1_l_rms, b1_r_rms, b1_pan, b1_start, b1_body, "burst1"),
            make_rust_dict(b2_l_rms, b2_r_rms, b2_pan, b2_start, b2_body, "burst2"),
        ],
    }

    # fixtures_dir は gen_dir（その子）を parents=True で作った時点で存在する。
    fixtures_dir = project_root / "test-assets" / "verify-fixtures" / "phase3"

    # selftest が作るファイルを集約し、try/finally で必ず掃除する（実 PCM
    # .gen/<fixture>.pcm は決して触らない）。各 rust/compare.json は write_and_run が追加。
    created: list[Path] = [pcm_path]

    def write_and_run(name: str, rust_dict: dict[str, Any]) -> bool:
        """rust_dict を <name>.rust.json に書いて run_fixture を回し、verdict ok を返す。"""
        d = copy.deepcopy(rust_dict)
        d["fixture"] = name
        rj = fixtures_dir / f"{name}.rust.json"
        with open(rj, "w") as f:
            json.dump(d, f, indent=2)
            f.write("\n")
        created.extend([rj, fixtures_dir / f"{name}.compare.json"])
        return run_fixture(name, fixtures_dir, fixtures_dir, python_ver)

    def fail(msg: str) -> None:
        print(f"[selftest ERROR] {msg}", file=sys.stderr)
        sys.exit(1)  # finally で cleanup が走る

    try:
        # -- 正常系: 全メトリクス正しく PASS。さらに spurious 検出も assert（I2）--
        print("[selftest] 正常系テスト（PASS + spurious 検出 が期待値）...")
        if not write_and_run("_selftest", rust_normal):
            fail("正常系が FAIL — スクリプトに問題あり")
        cmp = json.loads((fixtures_dir / "_selftest.compare.json").read_text())
        if cmp["spuriousOnsetCount"] < 1:
            fail(f"spurious burst が検出されない（spuriousOnsetCount={cmp['spuriousOnsetCount']}）")
        print("[selftest] 正常系 PASS / spurious 検出 確認")

        # -- 異常系: 各検出器を単独で flip（level / pan / onset-ours / onset-librosa）--
        # 1 ケース 1 摂動で、その検出器だけが verdict を FAIL にできることを確認する。
        # librosa 検出から ±ONSET_LIBROSA_FRAMES 外の位置（burst から遠い gap 中央）。
        far = b1_start + gap_frames // 4
        cases = [
            # level: L/R を同率拡大（pan 比は不変なので level だけが赤）
            ("_selftest_level",
             lambda e: e.update(lRms=e["lRms"] * 1.5, rRms=e["rRms"] * 1.5), "level"),
            # pan: pan フィールドを中央から外す（L/R 等倍では検出できない経路 = C1）
            ("_selftest_pan", lambda e: e.update(pan=0.6), "pan"),
            # onset-ours: threshold を 300ms ずらす（ours gate）
            ("_selftest_onset_ours",
             lambda e: e.update(onsetFrameThreshold=e["onsetFrameThreshold"] + 15000), "onset(ours)"),
            # onset-librosa: scheduled を burst から遠ざけ ours を追従させる（librosa_matched gate）
            ("_selftest_onset_lib",
             lambda e: e.update(onsetFrameScheduled=far, onsetFrameThreshold=far + 10),
             "onset(librosa)"),
        ]
        for name, mutate, detector in cases:
            print(f"[selftest] 異常系テスト [{detector}]（FAIL が期待値）...")
            bad = copy.deepcopy(rust_normal)
            mutate(bad["events"][0])
            if write_and_run(name, bad):
                fail(f"異常系 [{detector}] が PASS — この検出器が verdict を flip できていない")
            print(f"[selftest] 異常系 [{detector}] FAIL（期待通り）")

        print(
            "[selftest] 完了 — 正常系 PASS / spurious 検出 / "
            "level・pan・onset(ours)・onset(librosa) 各 FAIL 確認済み"
        )
    finally:
        # gen_dir 全体ではなく selftest が作ったファイルのみ削除（本物の PCM を保護）。
        _cleanup_selftest(*created)


def _cleanup_selftest(*paths: Path) -> None:
    # selftest が作ったファイルのみを削除する。ディレクトリは受け取らない
    # （gen_dir を rmtree すると同居する本物の <fixture>.pcm を巻き添えにするため）。
    for p in paths:
        try:
            if p.is_file():
                p.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# メインエントリ
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Phase-3 librosa cross-check — Rust 測定 JSON と librosa 独立測定を比較する"
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="合成 PCM を使って self-test を実行する（実 PCM 不要）",
    )
    args = parser.parse_args()

    python_ver = (
        f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    )

    # スクリプトの場所から逆算してプロジェクトルートを探す
    script_dir = Path(__file__).parent  # tests/audio/verify/phase3/
    # tests/audio/verify/phase3/ → 4 up → project root
    project_root = script_dir.parents[3]
    fixtures_dir = project_root / "test-assets" / "verify-fixtures" / "phase3"
    out_dir = fixtures_dir  # compare.json も同じ場所

    if args.selftest:
        run_selftest(script_dir, python_ver)
        return

    print(f"phase-3 librosa cross-check (Python {python_ver}, librosa {librosa.__version__})")
    print(f"fixtures: {fixtures_dir}")
    print()

    all_pass = True
    for fixture_name in FIXTURES:
        ok = run_fixture(fixture_name, fixtures_dir, out_dir, python_ver)
        if not ok:
            all_pass = False

    print()
    if all_pass:
        print("verdict: PASS — 全フィクスチャが許容内")
    else:
        print("verdict: FAIL — 許容を超えたメトリクスがあります", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
