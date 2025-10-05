// SuperCollider 動作確認テスト
const sc = require('supercolliderjs');

async function testSuperCollider() {
  console.log('🎵 SuperCollider サーバーを起動中...');
  
  try {
    const server = await sc.server.boot({
      scsynth: '/Applications/SuperCollider.app/Contents/Resources/scsynth'
    });
    console.log('✅ サーバー起動成功！');
    console.log(`Server ID: ${server.state.serverID}`);
    console.log(`Sample Rate: ${server.options.sampleRate}`);
    
    // オーディオファイル再生テスト
    const testFile = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/kick.wav';
    console.log(`\n🎵 テストファイル: ${testFile}`);
    
    // Buffer を割り当て
    const bufnum = 0;
    await server.callAndResponse({
      address: '/b_allocRead',
      args: [bufnum, testFile, 0, -1]
    });
    console.log('✅ バッファ読み込み成功！');
    
    // 再生
    console.log('🔊 再生中...');
    await server.sendMsg({
      address: '/s_new',
      args: ['default', -1, 0, 0]
    });
    
    // 2秒待機
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('\n✅ テスト完了！サーバーを終了します...');
    await server.quit();
    console.log('👋 終了');
    
  } catch (error) {
    console.error('❌ エラー:', error);
    await server.quit();
    process.exit(1);
  }
}

testSuperCollider();
