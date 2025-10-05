// SuperCollider 自前実装テスト（SuperDirt なし）
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
    
    // SynthDef をバイナリで送信
    console.log('\n📝 SynthDef を定義中...');
    
    // orbitPlayBuf SynthDef のバイナリ（後で作成）
    // 今は簡易版で test
    
    const synthDefSource = `
      (
        SynthDef(\\orbitPlayBuf, {
          arg out = 0, bufnum = 0, rate = 1, amp = 0.5, pan = 0, startPos = 0;
          var sig = PlayBuf.ar(1, bufnum, rate * BufRateScale.kr(bufnum), 
                               startPos: startPos * BufSampleRate.kr(bufnum),
                               loop: 0, doneAction: 2);
          Out.ar(out, Pan2.ar(sig, pan, amp));
        }).send(s);
      )
    `;
    
    console.log('⚠️ SynthDef の直接送信には sclang が必要です');
    console.log('代わりに、既存の simple SynthDef を使ってテストします...\n');
    
    // オーディオファイルをバッファにロード
    const audioFile = '/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/kick.wav';
    const bufnum = 0;
    
    console.log(`📂 バッファ ${bufnum} にロード: ${audioFile}`);
    
    await server.send.msg(['/b_allocRead', bufnum, audioFile, 0, -1]);
    
    // バッファ読み込み完了を待つ
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('✅ バッファ読み込み完了！');
    
    // 簡易的な再生テスト（UGen を直接使う）
    console.log('\n🔊 3回再生テスト...');
    
    for (let i = 0; i < 3; i++) {
      console.log(`  ${i + 1}回目...`);
      
      // /s_new の代わりに、/u_cmd でインライン UGen を実行
      // これも動かない可能性が高い...
      
      // 別のアプローチ: /d_recv で SynthDef を送信
      console.log('  (SynthDef がないため再生できません)');
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('\n💡 次のステップ:');
    console.log('1. SuperCollider IDE で SynthDef を作成');
    console.log('2. .scsyndef ファイルとして保存');
    console.log('3. Node.js から /d_load でロード');
    console.log('4. /s_new で再生');
    
    await server.quit();
    console.log('\n👋 終了');
    
  } catch (error) {
    console.error('❌ エラー:', error.message);
    if (server) {
      await server.quit();
    }
    process.exit(1);
  }
}

test();
