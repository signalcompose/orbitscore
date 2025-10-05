// SuperCollider ライブコーディングテスト
// kick と snare を loop で鳴らす

const sc = require('supercolliderjs');
const fs = require('fs');
const path = require('path');

class SimpleSCPlayer {
  constructor() {
    this.server = null;
    this.buffers = new Map(); // filepath -> {bufnum, duration}
    this.nextBufnum = 0;
    this.synthDefPath = path.join(__dirname, 'supercollider/synthdefs/orbitPlayBuf.scsyndef');
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
    
    console.log('✅ SynthDef ロード完了');
  }

  async loadBuffer(filepath) {
    if (this.buffers.has(filepath)) {
      return this.buffers.get(filepath);
    }

    const bufnum = this.nextBufnum++;
    
    await this.server.send.msg(['/b_allocRead', bufnum, filepath, 0, -1]);
    
    // Wait for buffer to load
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Query duration
    const duration = await this.queryBufferDuration(bufnum);
    
    this.buffers.set(filepath, { bufnum, duration });
    
    console.log(`📂 バッファ ${bufnum}: ${path.basename(filepath)} (${duration.toFixed(2)}秒)`);
    
    return { bufnum, duration };
  }

  async queryBufferDuration(bufnum) {
    // TODO: Implement proper duration query
    // For now, return fixed duration
    return 0.5; // 500ms
  }

  async play(filepath) {
    const { bufnum } = await this.loadBuffer(filepath);
    
    await this.server.send.msg([
      '/s_new',
      'orbitPlayBuf',
      -1,
      0,
      0,
      'bufnum', bufnum,
      'amp', 0.8,
      'rate', 1.0,
      'startPos', 0,
      'duration', 0,
    ]);
  }

  async quit() {
    if (this.server) {
      await this.server.quit();
      console.log('👋 サーバー終了');
    }
  }
}

async function test() {
  const player = new SimpleSCPlayer();
  
  try {
    await player.boot();
    
    const kickPath = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/kick.wav';
    const snarePath = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/snare.wav';
    
    // バッファをプリロード
    await player.loadBuffer(kickPath);
    await player.loadBuffer(snarePath);
    
    console.log('\n🎵 ライブコーディングテスト開始！');
    console.log('キックとスネアを交互に4回ずつ再生...\n');
    
    // Kick x 4
    for (let i = 0; i < 4; i++) {
      console.log(`  Kick ${i + 1}`);
      await player.play(kickPath);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Snare x 4
    for (let i = 0; i < 4; i++) {
      console.log(`  Snare ${i + 1}`);
      await player.play(snarePath);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
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
