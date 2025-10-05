// SuperCollider 直接 OSC でオーディオファイル再生
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
    
    // オーディオファイルをバッファにロード（OSC メッセージで直接）
    const audioFile = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/kick.wav';
    const bufnum = 0;
    
    console.log(`\n📂 バッファ ${bufnum} にロード中: ${audioFile}`);
    
    // /b_allocRead でバッファを割り当て＆読み込み
    await server.send.msg(['/b_allocRead', bufnum, audioFile, 0, -1]);
    
    // バッファ読み込み完了を待つ
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('✅ バッファ読み込み完了！');
    
    // 再生テスト（PlayBuf を使った簡易シンセ）
    console.log('\n🔊 キック音を3回再生（500ms間隔）...');
    
    for (let i = 0; i < 3; i++) {
      console.log(`  ${i + 1}回目...`);
      
      // /s_new で新しいシンセノードを作成
      // グループ0に追加、addAction=0(head), target=0(default group)
      await server.send.msg([
        '/s_new',
        'default',  // 使えないので別の方法を試す
        -1,  // node ID (-1 = 自動割り当て)
        0,   // add action (0 = head of group)
        0    // target group ID
      ]);
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('\n⚠️ default SynthDef がないので、d_recv で SynthDef を送信する必要があります');
    console.log('別のアプローチを試します...');
    
    await server.quit();
    console.log('👋 終了');
    
  } catch (error) {
    console.error('❌ エラー:', error.message);
    if (server) {
      await server.quit();
    }
    process.exit(1);
  }
}

test();
