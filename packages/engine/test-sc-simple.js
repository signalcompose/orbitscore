// SuperCollider 簡単な動作確認
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
    console.log('Sample Rate:', server.options.sampleRate);
    console.log('Block Size:', server.options.blockSize);
    
    // シンプルなサイン波テスト（3秒間）
    console.log('\n🔊 サイン波テスト（440Hz）を再生中...');
    
    await server.send.msg(['/s_new', 'default', 1000, 0, 0, 'freq', 440]);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    await server.send.msg(['/n_free', 1000]);
    
    console.log('✅ テスト完了！');
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
