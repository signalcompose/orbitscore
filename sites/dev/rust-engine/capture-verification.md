---
title: "RE-4. capture seam と客観検証（ORBIT_CAPTURE_WAV）"
chapter-id: "RE-4"
verified-against: f006a51
verified-at: "2026-09-03"
status: draft
---

> **Note**: 本ページは 2026-09-01 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# RE-4. capture seam と客観検証（ORBIT_CAPTURE_WAV）

OrbitScore の audio エンジンは「耳で聞く」以外の検証手段として **capture seam**
（Issue #307）を持ちます。`ORBIT_CAPTURE_WAV` 環境変数を設定すると、master 出力
（post-mix・device 直前）を WAV ファイルへ実時間で録音でき、そのファイルを
`orbit-audio-verify` の解析プリミティブ（onset 検出・RMS・pan 逆算）に通して
DSL の意図と実サンプルの一致を客観的に検証できます。本章はこの経路の実装
（`capture.rs` の自作 RIFF WAV writer）と、実際にどう「耳なし検証」を組み立てる
かを追います。

2026-08-29 の #651 で、この capture は「プロセスが異常終了しても開ける WAV」になりました。
同じ日に、実機 E2E が古い daemon バイナリで走ってしまう事故を機械的に止める仕組みも入っています。
どちらも「検証の一次資料が信用できるか」に直結するので、末尾に節を足しました。

## capture のタップ点: post-mix・pre-hardware

capture は `render_block_with_sources`（[RE-1](/rust-engine/) 参照）の中で post-processor
（master-bus effect）適用**後**、device に送る直前の `hw` バッファを読み取り専用でタップします。
これは「実際にデバイスへ出る最終信号」を録ることを意味し、capture の有無で出力サンプル自体は
変わりません（読むだけで mutation ではない）。

```rust
// rust/crates/orbit-audio-native/src/output.rs:662-707
fn render_block_with_sources(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    insert_buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    post: &mut Option<Box<dyn PostProcessor>>,
    capture: &mut Option<RingTapSink>,
    cb_stats: &Option<Arc<CallbackTimeStats>>,
    output_channels: usize,
    hw: &mut [f32],
) {
// ...
    // 読み取り専用 tap。`RingTapSink::commit` は wait-free / no-alloc（満杯時はあふれを drop カウント）
    // ＝ RT 契約を満たす。off-thread writer が ring を drain する。post の後・計測の内側に置くことで
    // capture コストも callback-duration に含めて監視する。
    if let Some(sink) = capture.as_mut() {
        sink.commit(hw);
    }

    if let (Some(stats), Some(t0)) = (cb_stats, t0) {
        stats.record(t0.elapsed().as_nanos() as u64);
    }
}
```

タップは `RingTapSink::commit` という wait-free / no-alloc な操作で行われ、
リングが満杯なら drop カウントで検出します（RT 契約を守りつつ off-thread writer
が追いつかない場合を可視化する）。ring の容量は `CAPTURE_RING_SECONDS = 8` 秒分で、
writer が一時的に遅れても吸収できるよう generous に確保されています（`output.rs:222`）。

## `RiffWavWriter`: 外部依存なしの自作 32-bit float WAV encoder

owner 確定方針（hound 等の外部 WAV encoder crate は追加しない）に基づき、
`capture.rs` は `std::io` のみで RIFF WAV を書きます。`wFormatTag = 3`
(`WAVE_FORMAT_IEEE_FLOAT`) を使うため量子化なし・録った f32 がそのまま
round-trip します。

```rust
// rust/crates/orbit-audio-native/src/capture.rs:37-64
/// 32-bit float(量子化なし)streaming WAV writer。`std::io` のみで実装する(外部 WAV encoder crate
/// を増やさない方針 = owner 確定・hound 不採用)。
///
/// ファイルサイズは書き込み終了時まで確定しないので、[`Self::new`] で size を 0 の placeholder
/// にした header をまず書き、サンプルを逐次追記した後、[`Self::finalize`] で実サイズに patch する。
pub struct RiffWavWriter {
    writer: BufWriter<File>,
    sample_rate: u32,
    channels: u16,
    samples_written: u64,
    /// `write` が per-call の alloc を避けるため再利用する little-endian バイトバッファ。
    scratch: Vec<u8>,
}

impl RiffWavWriter {
    /// `path` に新規ファイルを作り、size placeholder 込みの 44-byte header を書く。
    pub fn new(path: &Path, sample_rate: u32, channels: u16) -> io::Result<Self> {
        let file = File::create(path)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(&build_header(sample_rate, channels, 0))?;
        Ok(Self {
            writer,
            sample_rate,
            channels,
            samples_written: 0,
            scratch: Vec::new(),
        })
    }
```

サイズが確定しない問題（streaming write の間はファイル総サイズが未知）は
「0 の placeholder header を先に書き、`finalize()` で先頭に seek して実サイズを
patch する」という定石で解決しています。`finalize` は `self` を値で消費するため、
二重 finalize は型で防止されます。

```rust
// rust/crates/orbit-audio-native/src/capture.rs:110-127
    /// 先頭に seek して RIFF / data チャンクの size を実値に patch し、flush する。
    /// `self` を値で消費するので二重 finalize は型で防止される。
    ///
    /// # 既知の制限
    /// 古典 WAV(RIFF)の size フィールドは u32 なので、`samples_written * 4` バイトが
    /// 4GiB を超える capture は正しく表現できない(RF64 拡張が必要・未対応)。ここでは
    /// saturating して壊れた header にはしない。
    pub fn finalize(mut self) -> io::Result<()> {
        self.writer.flush()?;
        let data_bytes = self.data_bytes();
        // BufWriter<File>::seek は seek 前に内部バッファを flush してから inner を seek する
        // (std documented behavior)ので、直前の flush と合わせて安全に先頭へ戻れる。
        self.writer.seek(SeekFrom::Start(0))?;
        self.writer
            .write_all(&build_header(self.sample_rate, self.channels, data_bytes))?;
        self.writer.flush()?;
        Ok(())
    }
```

4GiB を超える capture は u32 size field の限界で正しく表現できません（RF64 拡張は
未対応）が、その場合も saturating で壊れた header にはしない、という明示的な
既知制限がコメントされています。この saturating の意味論は `data_bytes()` に 1 箇所だけ置かれ、
`finalize` と次節の `sync_header` が共有します。

## 異常終了でも開ける WAV: `sync_header` の定期 patch（#651）

ここが 2026-07-17 時点との最大の差分です。`finalize()` だけに header patch を任せると、
**プロセスが graceful に落ちなかった capture は size=0 の placeholder のまま残り、標準ツールで
開けません**。WORK_LOG 6.416 の実測では、E2E が残した WAV は RIFF size=36 / data size=0 のまま
2.29MB のデータを抱えており、macOS の `afinfo` は `estimated duration: 0.000000 sec` と読みました
（`CaptureWriter::Drop` が走っていなかった）。

対策は「約 1 秒ごとに header を実サイズへ patch し直す」ことです。

```rust
// rust/crates/orbit-audio-native/src/capture.rs:28-35
/// header の size を patch し直す間隔（サンプル数）。48kHz stereo で約 1 秒。
///
/// 🔴 `finalize` だけに任せると、**プロセスが graceful に落ちなかった capture は
/// size=0 の placeholder のまま残り、標準ツールで開けない**（2026-08-29 実測: E2E が
/// 残した WAV は RIFF size=36 / data size=0 で 2.29MB のデータを抱えていた。
/// `CaptureWriter::Drop` が走っていなかった）。capture は検証の一次資料なので、
/// **いつ落ちてもその時点まで有効な WAV** になるよう定期的に patch する。
const HEADER_SYNC_INTERVAL_SAMPLES: u64 = 48_000 * 2;
```

```rust
// rust/crates/orbit-audio-native/src/capture.rs:81-102
    /// header の size を「いまここまで書けた」値へ patch し、書き込み位置を末尾へ戻す。
    ///
    /// [`Self::finalize`] と違い `self` を消費しないので、drain ループの途中から何度でも
    /// 呼べる。目的は**プロセスが異常終了しても開ける WAV を残すこと**（[`HEADER_SYNC_INTERVAL_SAMPLES`]）。
    /// seek は BufWriter を flush してから inner を動かす（std documented）ので、
    /// 追記位置は `SeekFrom::End(0)` で正しく復元できる。
    pub fn sync_header(&mut self) -> io::Result<()> {
        // 🔴 **先に flush する。** `data_bytes()` は `samples_written` から計算するが、
        // `write` は **BufWriter へ渡した時点で**カウンタを進める。flush しないと、header が
        // 「ディスク上にまだ無いバイト」を指す WAV になる — `kill -9` されたとき（まさにこの
        // 機構が対象にしている状況）に **data チャンクが EOF を越える**。厳密なリーダは拒否する。
        // 毎秒 1 回なのでバッチングへの実害は無い。
        self.writer.flush()?;

        // 🔴 位置は `seek` で動かさない。`BufWriter::seek` は内部バッファを強制 flush してから
        // inner を動かすので、往復するたびに書き込み位置の管理が絡む。`write_at`（pwrite 相当）は
        // **ファイルのカーソルを動かさない**ので、追記は素直に進んだまま header だけを上書きできる
        // （macOS 限定プロジェクトなので `std::os::unix` は使える）。
        use std::os::unix::fs::FileExt;
        let header = build_header(self.sample_rate, self.channels, self.data_bytes());
        self.writer.get_ref().write_all_at(&header, 0)
    }
```

実装で気をつけたい点が 2 つコメントに書かれています。

1. **先に flush する。** `samples_written` は `BufWriter` へ渡した時点で進むので、flush せずに
   header を書くと「ディスク上にまだ無いバイト」を指す WAV になり、`kill -9` された瞬間に
   data チャンクが EOF を越えます。
2. **位置は `seek` で動かさない。** `BufWriter::seek` は内部バッファを flush してから inner を
   動かすので往復のたびに書き込み位置の管理が絡みます。`write_all_at`（`pwrite` 相当）は
   ファイルのカーソルを動かさないので、追記は素直に進んだまま header だけを上書きできます
   （macOS 限定プロジェクトなので `std::os::unix` を使える）。

## `CaptureWriter`: RT callback の外で drain する off-thread writer

`CaptureWriter::create` は WAV writer と `RingTapSink` を生成し、background
thread を spawn して ring を drain・書き込みを行います。RT callback は
`RingTapSink::commit`（wait-free）のみを呼び、実際のファイル I/O は audio
thread の外で完結します。drain ループの中に、上の `sync_header` を呼ぶ箇所があります。

```rust
// rust/crates/orbit-audio-native/src/capture.rs:186-256
    pub fn create(
        path: PathBuf,
        sample_rate: u32,
        channels: u16,
        ring_capacity: usize,
    ) -> io::Result<(RingTapSink, CaptureWriter)> {
        // 先に WAV ファイルを開く(path 不正等で失敗するなら ring を確保する前に fail fast)。
        let mut wav = RiffWavWriter::new(&path, sample_rate, channels)?;
        let (sink, mut consumer, drops) = RingTapSink::new(ring_capacity);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop);

        let handle = thread::spawn(move || -> io::Result<u64> {
            let mut samples_written: u64 = 0;
            let mut last_header_sync: u64 = 0;
            // drain ループ。write error は `break Err(e)` で抜け、下の finalize を必ず通す
            // (`?` で即 return すると finalize が走らず header が placeholder〈data=0〉のまま
            // 残り、壊れた WAV になる。best-effort finalize で「書けた分」を header に反映する)。
            let drain: io::Result<()> = loop {
                let avail = consumer.slots();
                if avail == 0 {
                    if stop_for_thread.load(Ordering::Acquire) {
                        break Ok(());
                    }
                    thread::sleep(DRAIN_POLL_INTERVAL);
                    continue;
                }
// ...
                samples_written += (a.len() + b.len()) as u64;
                chunk.commit_all();
                // 異常終了に備えて header を追いつかせる。
                //
                // 🔴 **失敗しても drain を止めない。** patch は「途中で落ちても開ける」ための
                // best-effort であり、**音声データの正しさには影響しない**。ここで `break` すると
                // 1 回の一時的な失敗で**以降の音声が一切録れなくなる** — capture を検証の一次資料
                // にするという本来の目的を、その保険が壊すことになる。
                //
                // 失敗は握り潰さず operator へ 1 行報告する（off-thread なので RT 契約に触れない）。
                // 最後に `finalize` が同じ patch を試みるので、一時的な失敗はそこで回復しうる。
                if samples_written - last_header_sync >= HEADER_SYNC_INTERVAL_SAMPLES {
                    last_header_sync = samples_written;
                    if let Err(e) = wav.sync_header() {
                        eprintln!(
                            "[capture] periodic WAV header sync failed (recording continues; \
                             the file may not open until finalize): {e}"
                        );
                    }
                }
            };
            // drain の成否に関わらず header を実サイズへ patch する(best-effort)。write error が
            // あればそれを優先して返し、無ければ finalize 自体の失敗を返す。
            let finalized = wav.finalize();
            match (drain, finalized) {
                (Ok(()), Ok(())) => Ok(samples_written),
                (Err(e), _) => Err(e),
                (Ok(()), Err(e)) => Err(e),
            }
        });
```

drain ループが write error に遭遇しても即 return せず、`break Err(e)` の後
必ず `finalize()` を呼ぶ点が silent-failure ガードになっています — 途中で
早期 return すると header が placeholder（`data=0`）のまま残って壊れた WAV
になるため、best-effort で「書けた分」を header に反映します。

面白いのは `sync_header` の失敗の扱いです。**失敗しても drain を止めません。** patch は
「途中で落ちても開ける」ための保険であって音声データの正しさには影響しないので、ここで
`break` すると 1 回の一時的な失敗で以降の音声が一切録れなくなり、保険が本来の目的を壊すことに
なります。失敗は握り潰さず stderr へ 1 行報告し、最後の `finalize` が同じ patch を試みます。

`OutputStream` 側は `_capture` フィールドを `_stream` より後に宣言することで、
Rust の struct field 宣言順 drop を利用し「stream 停止（callback 停止）→
writer が ring 残りを drain して finalize」という順序を構造的に保証しています。

```rust
// rust/crates/orbit-audio-native/src/output.rs:224-233
/// 生きている間はストリームを保持する RAII ハンドル。
pub struct OutputStream {
    _stream: Stream,
    /// capture seam（#307 realtime）: `ORBIT_CAPTURE_WAV` 有効時のみ `Some`。**`_stream` より後に
    /// 宣言する**ことで drop 順を「stream 停止（callback 停止＝以後 commit なし）→ writer が ring の
    /// 残りを drain して WAV を finalize」に固定する（Rust は struct field を宣言順に drop する）。
    _capture: Option<crate::capture::CaptureWriter>,
    render_state: Arc<std::sync::Mutex<RenderState>>,
    pub sample_rate: u32,
    pub channels: u16,
```

## 「客観検証」の実際: gated test の drops assert + oracle 一致

capture seam を使った検証の型は `rust/crates/orbit-audio-daemon/tests/`
配下の gated test（`--ignored` 付き・実 output device 要）に集約されています。
`capture_realtime_gated.rs`（#304 examples22 の realtime parity 検証）は
その代表例です:

```rust
// rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:208-219
    // teardown 前に drops を assert（silent-failure ガード）。
    let drops = guard.capture_drops();
    assert_eq!(
        drops,
        Some(0),
        "capture drop が発生（録音破損＝検証 invalid）: {drops:?}"
    );

    // guard を drop すると stream 停止 → writer が ring 残りを drain → WAV finalize。
    drop(guard);
    drop(wrap);
    std::env::remove_var("ORBIT_CAPTURE_WAV");
```

「客観検証の作法」はここに凝縮されています:

1. **teardown 前に `drops == 0` を assert** — off-thread writer が ring から
   取りこぼしていないことを検証前に固定します。`drops > 0` なら以降の全ての
   検証は無意味です（録音自体が壊れている）。
2. **WAV header と物理サイズの突き合わせ** — `finalize()` の header patch が
   失敗（例: disk full）すると header は placeholder のまま残りますが、PCM 本体
   自体は物理的に存在してしまいます。header の `data` チャンク size と実ファイル
   長を突き合わせないと、壊れた WAV でも PCM 読み取り自体は成功し偽陽性の
   parity が出ます:

```rust
// rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:104-111
    let data_bytes = u32::from_le_bytes(buf[40..44].try_into().unwrap()) as usize;
    assert_eq!(
        data_bytes,
        body.len(),
        "WAV data chunk size ({data_bytes}) が物理 body 長 ({}) と不一致 = finalize 失敗による \
         header 破損（録音 invalid）",
        body.len()
    );
```

3. **onset 検出でアンカーを取ってから相対位置で窓を取る** — device 起動
   latency で WAV 先頭が transport 0 とはずれるため、検出した最初の onset
   フレームを基準に、各イベントの相対位置で RMS 窓を切ります（絶対時刻での
   比較は device latency の分だけ必ずずれる）。
4. **pan は L/R RMS から逆算し、schedule の pan 値と許容誤差内か判定** — 
   厳密な gain dB 比較は同一サンプルを使う offline `per_event_gain` fixture
   に譲り、realtime capture は「領域に信号がある」「pan が合っている」の
   2 点を担う分業になっています。

## E2E は capture を「数値で」見る — #643 の master fader

capture WAV の RMS を数値で assert する E2E がどれだけ効くかは、2026-08-29 の #643 で実証されました。
`global.gain()` が instrument にまったく効いておらず、ミキサーの stage から master へ合流する音が
master gain を掛けた**後**に加算されていたのです（WORK_LOG 6.415）。各層は成功を返し ERROR は
1 行も出ていないので、ログでは捕まりません。ユニットテスト 2149 件も変異検証 35 件も
通っていました。捕まえたのは **capture WAV の RMS を実測した E2E だけ**です。

この経験から、`tests/e2e/gated-assertion-hygiene.spec.ts` が「capture するのに rms を見ていない
テスト」を red にし、`tests/e2e/dsl-e2e-coverage.spec.ts` が「DSL を足したのに E2E を書いていない」を
red にする、というラチェットが CLAUDE.md の規律とセットで入っています。

## 実機 E2E が古いバイナリで走らない仕組み（#651）

#651 の header 修正は、実装直後の実機 E2E で「効かない」と観測されました。原因は修正の誤りでは
なく、**E2E が 17:49 にビルドした古い daemon を使っていた**ことです（WORK_LOG 6.417）。拡張は
daemon を `<extension>/engine/bin/<platform>/` に同梱しており、これを更新するのは `npm run build`
の `build:copy-engine` であって `cargo build` ではありません。

対策は 2 段です。まず `tests/e2e/orbitstudio-mcp-gated.spec.ts` が、gated 実行の**モジュール読み込み時**
に「実際に spawn される daemon バイナリ（`resolveDaemonBinaryPath()` が正本）が `rust/` 配下の
`.rs` | `Cargo.toml` より古ければ、テストを 1 本も走らせずに落とす」チェックを持ちます。ただし
走査から外すディレクトリがあり、それは後述します（#713）。

```typescript
// tests/e2e/orbitstudio-mcp-gated.spec.ts:147-161
        walk(full)
      } else if (entry.name.endsWith('.rs') || entry.name === 'Cargo.toml') {
        const at = fs.statSync(full).mtimeMs
        if (at > newest.at) newest = { at, file: full }
      }
    }
  }
  walk(path.join(REPO_ROOT, 'rust'))
  if (newest.at > builtAt) {
    throw new Error(
      'gated E2E: the daemon binary is older than the Rust sources, so this run would measure ' +
        `stale code.\n  newest source: ${path.relative(REPO_ROOT, newest.file)}\n` +
        `  binary:        ${new Date(builtAt).toISOString()}\n` +
        `  source:        ${new Date(newest.at).toISOString()}\n` +
        'Rebuild before running (npm run test:e2e:gated does this for you):\n' +
```

そして `package.json` に `pretest:e2e:gated` を置き、`npm run test:e2e:gated` を打てば npm が
**必ず先に** cargo build + `npm run build` を走らせるようにしました（「手順が確実になったら
手動ではない形にする」という owner 判断）。

```jsonc
// package.json:17-17
    "test": "npm -w @orbitscore/engine test",
```

mtime 比較は「rebuild が no-op か」より弱い判定ですが、テスト実行前に 1ms で終わるのが利点で、
弱い分は「疑わしきは落とす」側に倒しています（等しい場合は通す）。

### 走査から外すもの — 再ビルドできないターゲットを見ない（#713）

この「疑わしきは落とす」には落とし穴がありました。走査が `rust/` 配下の `.rs` を無条件に拾うので、
`rust/crates/orbit-vst3-host/tests/spike_s_concurrent_load.rs` のような**統合テスト**が「最新の
ソース」に選ばれることがあるのです。統合テストは別の cargo ターゲットで、`orbit-audio-daemon` の
バイナリの依存グラフには入りません。ですから cargo は依存関係を正しく読んで何もビルドせず
（`Finished release profile in 0.21s`）、バイナリの mtime は更新されないままになります。ガードの
メッセージが指示する `npm run test:e2e:gated` を何度打っても消えない、**解消不能な赤**でした。

引き金は mtime の性質です。`git checkout` はファイルの mtime をチェックアウトした時刻へ更新するので、
ブランチを行き来しただけで、内容の変わっていない無関係な統合テストが「最新のソース」に化けます。
#713 の実測では、実機 gated が起動段階から 1 本も走らなくなりました。

そこで走査から `tests` / `benches` / `examples` の 3 ディレクトリを外しました。

```typescript
// tests/e2e/orbitstudio-mcp-gated.spec.ts:142-146
        // ⚠️ **`src/` は除外しない。** daemon が依存するコードが新しければ、
        // ガードは本来の役目どおり赤くなるべきである（CLAUDE.md「実機テストは最新ビルドで走る」）。
        if (entry.name === 'tests' || entry.name === 'benches' || entry.name === 'examples') {
          continue
        }
```

外してよい根拠は「別ターゲットなので daemon バイナリに入らない」の一点だけで、`src/` を外す根拠には
なりません。daemon が依存するコードが新しければ、ガードは本来の役目どおり赤くなるべきだからです。
この線引きは `tests/e2e/gated-assertion-hygiene.spec.ts` の検査 2 本で両側から留められています。
除外が消えたら赤、`src` まで除外したら赤、という組み合わせです。

ただしどちらの検査も gated spec の**ソース文字列**を走査するだけなので、保証するのは「そう書いてある」
ことまでです。ガード本体の `assertDaemonBinaryIsNotStale()` は `gated && appAvailable` のときだけ
呼ばれるため、通常の `npm test` では 1 行も実行されません。ここは「実行された振る舞い」ではなく
「書かれた形」を留める仕掛け、という位置づけで読むのが正確です。

## エンジン自身の peak ログ: `post_peak_bits`

capture WAV とは別に、エンジンは daemon 層で自分自身の post-mix peak を
`AtomicU32`（f32 bits）として保持し続けています。これは非負 f32 の bit 表現が
値の大小と一致することを利用した lock-free な `fetch_max` 実装で、instrument/effect それぞれに
専用のフィールドがあります（`outproc_instrument.rs::OutProcInstrumentStats.post_peak_bits` /
`outproc_effect.rs::OutProcEffectStats.post_peak_bits`）。gated test は
これを `engine.outproc_instrument_post_peak()` 等のアクセサ経由で読み、
`ORBIT_CAPTURE_WAV` で録った WAV の実測 peak と突き合わせる二重チェックに
使えます。

## Try it: capture → peak 突き合わせループ

1. daemon を `ORBIT_CAPTURE_WAV=<path>.wav` を設定して起動します:

```bash
ORBIT_CAPTURE_WAV=/tmp/orbit-capture.wav cargo test -p orbit-audio-daemon \
  --test capture_realtime_gated -- --ignored --nocapture
```

（このテストは自身で `ORBIT_CAPTURE_WAV` を一意な temp path にセットするので、
上記のように外部から指定しても内部で上書きされます。手動で任意の DSL セッション
に対して capture したい場合は、daemon 起動前に `ORBIT_CAPTURE_WAV` を export
してから通常の `RUN` フローを実行します。）

2. teardown 後、`drops == 0` を確認します（gated test は自動 assert、手動運用
   では `guard.capture_drops()` を呼ぶか、stderr の `[capture]` 行を確認します。
   `eprintln!` は MCP の `get_log` には出ないので、stderr を直接見る必要があります —
   WORK_LOG 6.417 で「観測が空 = 事象の不在」と読み違えた記録があります）。
3. 録れた WAV をロードして peak / RMS を計測します（`orbit-audio-verify` の
   `region_rms` / `detect_onset_threshold` 等のプリミティブ、もしくは
   `soxi`/`ffprobe`/`afinfo` 等の外部ツールで簡易確認）。#651 以降は、途中で daemon を
   落としてもその時点までの WAV が開けるはずです。
4. 可能ならエンジン側の `post_peak` 系アクセサ（`outproc_instrument_post_peak`
   相当）を同じセッションで読み、capture WAV の実測 peak と比較します。

**期待値（実機で相互検証済み・2026-07-17）**: tap 点が同じ `hw`（post-mix・post 適用後）
である以上、両者は一致します。実測例: clap-test-synth（既知振幅 0.25）の同一 oracle に対し、
gated テストの stats 側 `post_mix_peak` = **0.25000**（`outproc_instrument_vst3_gated` 等）、
DSL E2E の capture WAV 実測 peak = **0.25000**（WORK_LOG 6.258）— 独立した 2 計測経路が
既知振幅と 5 桁一致しており、capture と post_peak 系アクセサが同じ信号を見ていることの
実証になっています。2026-09-01 の再読ではこの数値を再実測していません。

## 次の深掘り候補

- `tests/e2e/gated-assertion-hygiene.spec.ts` が名指しで red にする条件の一覧と、その根拠になった事故
- `orbit-audio-verify` のプリミティブ（`region_rms` / `detect_onset_threshold` / pan 逆算）の実装
- capture mode B（per-play・follow-on）のための `CaptureWriter::finish` の使い道
- `resolveDaemonBinaryPath()` の解決順（explicit → env → monorepo-release → monorepo-debug → extension-bundle）

## Sources

- `rust/crates/orbit-audio-native/src/output.rs:222-233,662-707` — `CAPTURE_RING_SECONDS` / `OutputStream`（`_capture` フィールドの drop 順保証）/ `render_block_with_sources`（capture タップの位置）
- `rust/crates/orbit-audio-native/src/capture.rs:21-35` — 定数（`HEADER_SYNC_INTERVAL_SAMPLES` と #651 の経緯）
- `rust/crates/orbit-audio-native/src/capture.rs:37-127` — `RiffWavWriter`（32-bit float・外部 crate 不使用・`sync_header`・`data_bytes`・`finalize`）
- `rust/crates/orbit-audio-native/src/capture.rs:186-256` — `CaptureWriter::create`（off-thread drain ループ・定期 header patch・best-effort finalize）
- `rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:1-23` — capture seam realtime gated test のモジュールコメント（役割・実行方法）
- `rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:99-111` — WAV header/物理サイズ突き合わせ（silent-failure ガード）
- `rust/crates/orbit-audio-daemon/tests/capture_realtime_gated.rs:206-217` — `drops == 0` assert（teardown 前の silent-failure ガード）
- `rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:232-234` — `post_peak_bits`（lock-free peak 累積の実装）
- `tests/e2e/orbitstudio-mcp-gated.spec.ts:80-154` — stale artifact ガード（`assertDaemonBinaryIsNotStale`）
- `package.json:17-18` — `pretest:e2e:gated` / `test:e2e:gated`
- [`docs/archive/WORK_LOG_2026-08.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-08.md) 6.415 / 6.416 / 6.417 — #643 master fader の発見、#651 の header patch と stale ガード、pretest 自動化
- Issue [#307](https://github.com/signalcompose/orbitscore/issues/307) — capture seam realtime 配線
- Issue [#651](https://github.com/signalcompose/orbitscore/issues/651) — 異常終了でも開ける capture WAV と stale バイナリ対策
- Issue [#713](https://github.com/signalcompose/orbitscore/issues/713) — 再ビルド不能な cargo ターゲットを走査から外す
