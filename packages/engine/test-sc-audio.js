// SuperCollider オーディオファイル再生テスト
const sc = require('supercolliderjs');

async function test() {
  console.log('🎵 SuperCollider サーバーを起動中...');
  
  let server;
  try {
    server = await sc.server.boot({
      scsynth: '/Applications/SuperCollider.app/Contents/Resources/scsynth',
      debug: false
    });
    
    console.log('✅ サーバー起動成功！');
    
    // SynthDef を定義（オーディオファイル再生用）
    console.log('\n📝 SynthDef を定義中...');
    await sc.lang.boot({
      sclang: '/Applications/SuperCollider.app/Contents/MacOS/sclang'
    });
    
    await sc.lang.interpret(`
      SynthDef(\\playBuf, {
        arg bufnum = 0, rate = 1, startPos = 0, amp = 0.5, out = 0;
        var sig = PlayBuf.ar(1, bufnum, rate * BufRateScale.kr(bufnum), 
                             startPos: startPos * BufSampleRate.kr(bufnum),
                             loop: 0, doneAction: 2);
        Out.ar(out, sig * amp ! 2);
      }).add;
    `);
    
    console.log('✅ SynthDef 定義完了！');
    
    // バッファにオーディオファイルをロード
    const audioFile = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/kick.wav';
    console.log(`\n📂 オーディオファイルをロード: ${audioFile}`);
    
    const bufnum = 0;
    await sc.lang.interpret(`
      Buffer.read(s, "${audioFile}", bufnum: ${bufnum});
    `);
    
    await new Promise(resolve => setTimeout(resolve, 500)); // バッファ読み込み待機
    
    console.log('✅ バッファ読み込み完了！');
    
    // 再生テスト
    console.log('\n🔊 キック音を3回再生...');
    
    for (let i = 0; i < 3; i++) {
      await server.send.msg(['/s_new', 'playBuf', -1, 0, 0, 'bufnum', bufnum, 'amp', 0.8]);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('✅ テスト完了！');
    await sc.lang.quit();
    await server.quit();
    console.log('👋 終了');
    
  } catch (error) {
    console.error('❌ エラー:', error.message);
    console.error(error.stack);
    if (server) {
      try { await sc.lang.quit(); } catch(e) {}
      await server.quit();
    }
    process.exit(1);
  }
}

test();
