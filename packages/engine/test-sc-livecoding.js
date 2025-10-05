// SuperCollider ライブコーディングテスト
// kick と snare を loop で鳴らす（AdvancedAudioPlayer と同じインターフェース）

const sc = require('supercolliderjs');
const fs = require('fs');
const path = require('path');

class SuperColliderPlayer {
  constructor() {
    this.server = null;
    this.bufferCache = new Map(); // filepath -> {bufnum, duration}
    this.bufferDurations = new Map(); // bufnum -> duration
    this.nextBufnum = 0;
    this.synthDefPath = path.join(__dirname, 'supercollider/synthdefs/orbitPlayBuf.scsyndef');
    
    // Scheduler
    this.isRunning = false;
    this.startTime = 0;
    this.scheduledPlays = [];
    this.sequenceEvents = new Map();
    this.intervalId = null;
  }

  async boot() {
    console.log('🎵 SuperCollider サーバーを起動中...');
    
    this.server = await sc.server.boot({
      scsynth: '/Applications/SuperCollider.app/Contents/Resources/scsynth',
      debug: false,
    });
    
    console.log('✅ サーバー起動成功');
    
    // Load SynthDef
    const synthDefData = fs.readFileSync(this.synthDefPath);
    await this.server.send.msg(['/d_recv', synthDefData]);
    
    // Wait for SynthDef to be ready
    await new Promise(resolve => setTimeout(resolve, 200));
    
    console.log('✅ SynthDef ロード完了');
  }

  async loadBuffer(filepath) {
    if (this.bufferCache.has(filepath)) {
      return this.bufferCache.get(filepath);
    }

    const bufnum = this.nextBufnum++;
    
    await this.server.send.msg(['/b_allocRead', bufnum, filepath, 0, -1]);
    
    // Query duration
    const duration = await this.queryBufferDuration(bufnum);
    
    const bufferInfo = { bufnum, duration };
    this.bufferCache.set(filepath, bufferInfo);
    this.bufferDurations.set(bufnum, duration);
    
    console.log(`📂 バッファ ${bufnum}: ${path.basename(filepath)} (${duration.toFixed(3)}秒)`);
    
    return bufferInfo;
  }

  async queryBufferDuration(bufnum) {
    // Simplified: use default duration for now
    // TODO: Implement proper /b_query response handling
    return 0.5; // Assume 0.5 second for drum samples
  }

  scheduleEvent(filepath, startTimeMs, volume = 80, sequenceName = '') {
    this.scheduledPlays.push({
      time: startTimeMs,
      filepath,
      options: { volume },
      sequenceName,
    });
    
    this.scheduledPlays.sort((a, b) => a.time - b.time);
  }

  async executePlayback(filepath, options, sequenceName, scheduledTime) {
    const launchTime = Date.now();
    const actualStartTime = launchTime - this.startTime;
    const drift = actualStartTime - scheduledTime;

    console.log(`🔊 Playing: ${sequenceName} at ${actualStartTime}ms (scheduled: ${scheduledTime}ms, drift: ${drift}ms)`);

    const { bufnum } = await this.loadBuffer(filepath);
    const volume = options.volume !== undefined ? options.volume / 100 : 0.5;

    await this.server.send.msg([
      '/s_new',
      'orbitPlayBuf',
      -1,
      0,
      0,
      'bufnum', bufnum,
      'amp', volume,
      'rate', 1.0,
      'startPos', 0,
      'duration', 0,
    ]);
  }

  startScheduler() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.startTime = Date.now();
    
    console.log('▶️  Scheduler started');

    this.scheduledPlays.sort((a, b) => a.time - b.time);

    this.intervalId = setInterval(() => {
      const now = Date.now() - this.startTime;

      while (
        this.scheduledPlays.length > 0 &&
        this.scheduledPlays[0].time <= now
      ) {
        const play = this.scheduledPlays.shift();
        this.executePlayback(play.filepath, play.options, play.sequenceName, play.time);
      }
    }, 1);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('⏹️  Scheduler stopped');
  }

  clearSequenceEvents(sequenceName) {
    this.scheduledPlays = this.scheduledPlays.filter(play => play.sequenceName !== sequenceName);
  }

  async quit() {
    if (this.server) {
      this.stop();
      await this.server.quit();
      console.log('👋 SuperCollider サーバー終了');
    }
  }
}

// テスト
async function test() {
  const player = new SuperColliderPlayer();
  
  try {
    await player.boot();
    
    const kickPath = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/kick.wav';
    const snarePath = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/snare.wav';
    
    console.log('\n🎵 ライブコーディングテスト: kick と snare のループ');
    console.log('BPM 120, 4/4拍子');
    console.log('Kick: 1拍目, 3拍目');
    console.log('Snare: 2拍目, 4拍目\n');
    
    // Scheduler 起動
    player.startScheduler();
    
    // Kick パターン (1, 0, 1, 0) - 2000ms 周期
    const scheduleKick = () => {
      const now = Date.now() - player.startTime;
      player.scheduleEvent(kickPath, now + 0, 80, 'kick');
      player.scheduleEvent(kickPath, now + 1000, 80, 'kick');
    };
    
    // Snare パターン (0, 1, 0, 1) - 2000ms 周期
    const scheduleSnare = () => {
      const now = Date.now() - player.startTime;
      player.scheduleEvent(snarePath, now + 500, 80, 'snare');
      player.scheduleEvent(snarePath, now + 1500, 80, 'snare');
    };
    
    // 最初のループをスケジュール
    scheduleKick();
    scheduleSnare();
    
    // 2秒ごとにループを再スケジュール (4ループ = 8秒)
    const kickLoop = setInterval(() => {
      player.clearSequenceEvents('kick');
      scheduleKick();
    }, 2000);
    
    const snareLoop = setInterval(() => {
      player.clearSequenceEvents('snare');
      scheduleSnare();
    }, 2000);
    
    // 8秒後に停止
    setTimeout(() => {
      clearInterval(kickLoop);
      clearInterval(snareLoop);
      player.stop();
      
      console.log('\n✅ テスト完了！');
      
      setTimeout(async () => {
        await player.quit();
        process.exit(0);
      }, 1000);
    }, 8000);
    
  } catch (error) {
    console.error('❌ エラー:', error.message);
    console.error(error.stack);
    await player.quit();
    process.exit(1);
  }
}

test();
