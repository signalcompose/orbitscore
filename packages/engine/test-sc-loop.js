// SuperCollider ループ再生テスト
// OrbitScore の sequence.loop() と同じ動作

const sc = require('supercolliderjs');
const fs = require('fs');
const path = require('path');

class LoopingSCPlayer {
  constructor() {
    this.server = null;
    this.buffers = new Map();
    this.nextBufnum = 0;
    this.synthDefPath = path.join(__dirname, 'supercollider/synthdefs/orbitPlayBuf.scsyndef');
    this.scheduledEvents = [];
    this.isRunning = false;
    this.startTime = 0;
    this.intervalId = null;
    this.sequences = new Map(); // sequenceName -> {filepath, pattern, looping, loopTimer}
  }

  async boot() {
    console.log('🎵 SuperCollider サーバーを起動中...');
    
    this.server = await sc.server.boot({
      scsynth: '/Applications/SuperCollider.app/Contents/Resources/scsynth',
      debug: false,
    });
    
    console.log('✅ サーバー起動成功');
    
    const synthDefData = fs.readFileSync(this.synthDefPath);
    await this.server.send.msg(['/d_recv', synthDefData]);
    
    console.log('✅ SynthDef ロード完了');
  }

  async loadBuffer(filepath) {
    if (this.buffers.has(filepath)) {
      return this.buffers.get(filepath);
    }

    const bufnum = this.nextBufnum++;
    
    await this.server.send.msg(['/b_allocRead', bufnum, filepath, 0, -1]);
    await new Promise(resolve => setTimeout(resolve, 200));
    
    this.buffers.set(filepath, { bufnum, duration: 0.5 });
    console.log(`📂 バッファ ${bufnum}: ${path.basename(filepath)}`);
    
    return { bufnum, duration: 0.5 };
  }

  // シーケンスを登録
  registerSequence(name, filepath, pattern) {
    this.sequences.set(name, {
      filepath,
      pattern, // [0, 500, 1000, 1500] のようなタイミング配列
      looping: false,
      loopTimer: null,
    });
  }

  // シーケンスをループ開始
  async loop(name) {
    const seq = this.sequences.get(name);
    if (!seq) {
      console.error(`❌ Sequence not found: ${name}`);
      return;
    }

    if (seq.looping) {
      return; // 既にループ中
    }

    seq.looping = true;
    
    await this.loadBuffer(seq.filepath);
    
    console.log(`🔁 ${name}.loop() started`);
    
    // パターンの長さを計算（最後のイベント時刻 + バッファ長）
    const patternDuration = 2000; // 1小節 = 2000ms (BPM120, 4/4)
    
    // 最初のイテレーションをスケジュール
    this.schedulePattern(name, seq, 0);
    
    // ループタイマーを設定
    seq.loopTimer = setInterval(() => {
      if (seq.looping) {
        this.clearSequenceEvents(name);
        const nextTime = Date.now() - this.startTime;
        this.schedulePattern(name, seq, nextTime);
      }
    }, patternDuration);
  }

  // パターンをスケジュール
  schedulePattern(name, seq, baseTime) {
    for (const offset of seq.pattern) {
      this.scheduleEvent(seq.filepath, baseTime + offset, name);
    }
  }

  // シーケンスを停止
  stop(name) {
    const seq = this.sequences.get(name);
    if (!seq) return;

    seq.looping = false;
    
    if (seq.loopTimer) {
      clearInterval(seq.loopTimer);
      seq.loopTimer = null;
    }

    this.clearSequenceEvents(name);
    console.log(`⏹️  ${name}.stop()`);
  }

  // 特定シーケンスのイベントをクリア
  clearSequenceEvents(name) {
    this.scheduledEvents = this.scheduledEvents.filter(e => e.sequenceName !== name);
  }

  // イベントをスケジュール
  scheduleEvent(filepath, timeMs, sequenceName) {
    this.scheduledEvents.push({ filepath, timeMs, sequenceName });
    this.scheduledEvents.sort((a, b) => a.timeMs - b.timeMs);
  }

  // スケジューラーを開始
  startScheduler() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.startTime = Date.now();
    
    console.log('\n▶️  スケジューラー開始\n');
    
    this.intervalId = setInterval(async () => {
      const now = Date.now() - this.startTime;
      
      while (this.scheduledEvents.length > 0 && this.scheduledEvents[0].timeMs <= now) {
        const event = this.scheduledEvents.shift();
        const drift = now - event.timeMs;
        
        console.log(`🔊 ${event.sequenceName} at ${now}ms (drift: ${drift}ms)`);
        
        const { bufnum } = await this.loadBuffer(event.filepath);
        
        await this.server.send.msg([
          '/s_new', 'orbitPlayBuf', -1, 0, 0,
          'bufnum', bufnum,
          'amp', 0.8,
          'rate', 1.0,
          'startPos', 0,
          'duration', 0,
        ]);
      }
    }, 1);
  }

  stopScheduler() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('\n⏹️  スケジューラー停止');
  }

  async quit() {
    // すべてのループを停止
    for (const [name] of this.sequences) {
      this.stop(name);
    }
    
    this.stopScheduler();
    
    if (this.server) {
      await this.server.quit();
      console.log('👋 サーバー終了');
    }
  }
}

async function test() {
  const player = new LoopingSCPlayer();
  
  try {
    await player.boot();
    
    const kickPath = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/kick.wav';
    const snarePath = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/snare.wav';
    
    // シーケンスを登録
    // Kick: 1拍目、3拍目（0ms, 1000ms）
    player.registerSequence('kick', kickPath, [0, 1000]);
    
    // Snare: 2拍目、4拍目（500ms, 1500ms）
    player.registerSequence('snare', snarePath, [500, 1500]);
    
    console.log('\n🎵 OrbitScore スタイルのライブコーディングテスト\n');
    
    // global.run()
    player.startScheduler();
    
    // kick.loop()
    await player.loop('kick');
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // snare.loop()
    await player.loop('snare');
    
    console.log('');
    
    // 6秒再生（3ループ）
    await new Promise(resolve => setTimeout(resolve, 6000));
    
    // kick.stop()
    player.stop('kick');
    
    // snare だけ2秒
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // global.stop()
    player.stopScheduler();
    
    console.log('\n✅ テスト完了！');
    await player.quit();
    
  } catch (error) {
    console.error('❌ エラー:', error.message);
    console.error(error.stack);
    await player.quit();
    process.exit(1);
  }
}

test();
