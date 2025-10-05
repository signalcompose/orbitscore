// SuperCollider 高精度スケジューリングテスト
// OrbitScore のスケジューラーと同じように事前にイベントをスケジュールして再生

const sc = require('supercolliderjs');
const fs = require('fs');
const path = require('path');

class ScheduledSCPlayer {
  constructor() {
    this.server = null;
    this.buffers = new Map();
    this.nextBufnum = 0;
    this.synthDefPath = path.join(__dirname, 'supercollider/synthdefs/orbitPlayBuf.scsyndef');
    this.scheduledEvents = [];
    this.isRunning = false;
    this.startTime = 0;
    this.intervalId = null;
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
    
    const duration = await this.queryBufferDuration(bufnum);
    
    this.buffers.set(filepath, { bufnum, duration });
    console.log(`📂 バッファ ${bufnum}: ${path.basename(filepath)} (${duration.toFixed(2)}秒)`);
    
    return { bufnum, duration };
  }

  async queryBufferDuration(bufnum) {
    // 簡易版: デフォルト値を使用（後で実装）
    return 0.5;
  }

  // イベントをスケジュール（時間は相対時間 ms）
  scheduleEvent(filepath, timeMs, sequenceName) {
    this.scheduledEvents.push({ filepath, timeMs, sequenceName });
    // 時間順にソート
    this.scheduledEvents.sort((a, b) => a.timeMs - b.timeMs);
  }

  // スケジューラーを開始
  startScheduler() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.startTime = Date.now();
    
    console.log('\n▶️  スケジューラー開始');
    
    // 1ms 精度のスケジューリングループ
    this.intervalId = setInterval(async () => {
      const now = Date.now() - this.startTime;
      
      while (this.scheduledEvents.length > 0 && this.scheduledEvents[0].timeMs <= now) {
        const event = this.scheduledEvents.shift();
        const drift = now - event.timeMs;
        
        console.log(`🔊 Playing: ${event.sequenceName} at ${now}ms (scheduled: ${event.timeMs}ms, drift: ${drift}ms)`);
        
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

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('\n⏹️  スケジューラー停止');
  }

  async quit() {
    this.stop();
    if (this.server) {
      await this.server.quit();
      console.log('👋 サーバー終了');
    }
  }
}

async function test() {
  const player = new ScheduledSCPlayer();
  
  try {
    await player.boot();
    
    const kickPath = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/kick.wav';
    const snarePath = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/snare.wav';
    
    // バッファをプリロード
    await player.loadBuffer(kickPath);
    await player.loadBuffer(snarePath);
    
    console.log('\n🎵 8ビートパターンをスケジュール（BPM120 = 1拍500ms）');
    
    // Kick: 1拍目、3拍目（0ms, 1000ms, 2000ms, 3000ms）
    player.scheduleEvent(kickPath, 0, 'kick');
    player.scheduleEvent(kickPath, 1000, 'kick');
    player.scheduleEvent(kickPath, 2000, 'kick');
    player.scheduleEvent(kickPath, 3000, 'kick');
    
    // Snare: 2拍目、4拍目（500ms, 1500ms, 2500ms, 3500ms）
    player.scheduleEvent(snarePath, 500, 'snare');
    player.scheduleEvent(snarePath, 1500, 'snare');
    player.scheduleEvent(snarePath, 2500, 'snare');
    player.scheduleEvent(snarePath, 3500, 'snare');
    
    console.log(`✅ ${player.scheduledEvents.length} イベントをスケジュール完了\n`);
    
    // スケジューラー開始
    player.startScheduler();
    
    // 5秒待機
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    player.stop();
    
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
