// SuperCollider 完全テスト（自前 SynthDef 使用）
const sc = require('supercolliderjs');
const fs = require('fs');
const path = require('path');

async function test() {
  console.log('🎵 SuperCollider サーバーを起動中...');
  
  let server;
  try {
    server = await sc.server.boot({
      scsynth: '/Applications/SuperCollider.app/Contents/Resources/scsynth',
      debug: false
    });
    
    console.log('✅ サーバー起動成功！');
    
    // SynthDef をロード
    const synthDefPath = path.join(__dirname, 'supercollider/synthdefs/orbitPlayBuf.scsyndef');
    console.log(`\n📝 SynthDef をロード: ${synthDefPath}`);
    
    const synthDefData = fs.readFileSync(synthDefPath);
    
    // /d_recv で SynthDef を送信
    await server.send.msg(['/d_recv', synthDefData]);
    
    console.log('✅ SynthDef ロード完了！');
    
    // オーディオファイルをバッファにロード
    const audioFile = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/kick.wav';
    const bufnum = 0;
    
    console.log(`\n📂 バッファ ${bufnum} にロード: ${audioFile}`);
    
    await server.send.msg(['/b_allocRead', bufnum, audioFile, 0, -1]);
    
    // バッファ読み込み完了を待つ
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('✅ バッファ読み込み完了！');
    
    // 再生テスト
    console.log('\n🔊 キック音を3回再生（500ms間隔）...');
    
    for (let i = 0; i < 3; i++) {
      console.log(`  ${i + 1}回目...`);
      
      // /s_new で orbitPlayBuf シンセを起動
      await server.send.msg([
        '/s_new',
        'orbitPlayBuf',  // SynthDef 名
        -1,              // node ID (-1 = 自動割り当て)
        0,               // add action (0 = head)
        0,               // target group
        'bufnum', bufnum,
        'amp', 0.8,
        'rate', 1.0
      ]);
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('\n✅ テスト完了！');
    await server.quit();
    console.log('👋 終了');
    
  } catch (error) {
    console.error('❌ エラー:', error.message);
    console.error(error.stack);
    if (server) {
      await server.quit();
    }
    process.exit(1);
  }
}

test();
