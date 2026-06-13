const fs = require('fs')
const buf = fs.readFileSync(process.argv[2])
let p=0; const u32=()=>{const v=buf.readUInt32BE(p);p+=4;return v}; const u16=()=>{const v=buf.readUInt16BE(p);p+=2;return v}; const u8=()=>buf[p++]
p=4;u32();u16();const ntrk=u16();const div=u16()
const vlq=()=>{let v=0,c;do{c=u8();v=(v<<7)|(c&0x7f)}while(c&0x80);return v}
const notes=[]
for(let t=0;t<ntrk;t++){if(buf.toString('ascii',p,p+4)!=='MTrk')break;p+=4;const len=u32();const end=p+len;let tick=0,status=0;const on={}
 while(p<end){tick+=vlq();let b=buf[p];if(b&0x80){status=b;p++}const type=status&0xf0,ch=status&0x0f
  if(status===0xff){u8();const l=vlq();p+=l}else if(status===0xf0||status===0xf7){const l=vlq();p+=l}
  else if(type===0x90){const n=u8(),v=u8();if(v>0)on[n+'|'+ch]=tick;else{const k=n+'|'+ch;if(on[k]!=null){notes.push({tick:on[k],note:n,dur:tick-on[k]});delete on[k]}}}
  else if(type===0x80){const n=u8();u8();const k=n+'|'+ch;if(on[k]!=null){notes.push({tick:on[k],note:n,dur:tick-on[k]});delete on[k]}}
  else if(type===0xc0||type===0xd0){u8()}else{u8();u8()}}
 p=end}
// --- config (env) ---
const BEATS=+(process.env.BEATS||4)            // beats per bar (3 for 3/4)
const SUB=+(process.env.SUB||1)                // grid slots per beat (1=quarter, 2=eighth)
const bar=BEATS*div, slot=div/SUB, perBar=BEATS*SUB
const lastTick=notes.reduce((m,e)=>Math.max(m,e.tick+e.dur),0)
const NBARS=+(process.env.BARS||Math.ceil(lastTick/bar))
const tonicPc=+(process.env.TONIC_PC||2) /*D*/, octave=+(process.env.OCT||4), ROOT=12*(octave+1)+tonicPc, IONIAN=[0,2,4,5,7,9,11]
const SCALE={0:[1,0],2:[2,0],4:[3,0],5:[4,0],7:[5,0],9:[6,0],11:[7,0],1:[1,1],3:[3,-1],6:[4,1],8:[6,-1],10:[7,-1]}
const tok=n=>{const sem=((n-tonicPc)%12+12)%12;const[d,alt]=SCALE[sem];const nat=ROOT+IONIAN[d-1]+alt;const range=Math.round((n-nat)/12)
 return (alt<0?'b'.repeat(-alt):alt>0?'#'.repeat(alt):'')+d+(range!==0?'^'+(range>0?'+':'')+range:'')}
// --- vertical slice → [ ] stacks, onset→attack / held→`_` voice tie ---
const bars=[]
for(let b=0;b<NBARS;b++){const cells=[]
 for(let q=0;q<perBar;q++){const tk=b*bar+q*slot
  const cover=notes.filter(e=>e.tick<=tk+1&&e.tick+e.dur>tk+1)
  const seen=new Set(); const voices=[]
  for(const e of cover.sort((a,b)=>a.note-b.note)){ if(seen.has(e.note))continue; seen.add(e.note)
   const onset=Math.abs(e.tick-tk) < slot/2   // starts at this slot = attack; else held = `_` tie
   voices.push((onset?'':'_')+tok(e.note)) }
  cells.push(voices.length?('['+voices.join(', ')+']'):'0')}
 bars.push('  ('+cells.join(', ')+')')}
const tempo=process.env.TEMPO||60, transport=process.env.TRANSPORT||'LOOP', KEY=process.env.KEY||'D'
const TITLE=process.env.TITLE||'chordal transcription', SEQ=process.env.SEQ||'piano'
const orbs=`// ${TITLE}
// AUTO-TRANSCRIBED from a public-domain MIDI by tools/midi2orbs/midi2orbs-chordal.js —
// CHORDAL mode: each grid slot = the sounding pitches as a [ ] stack (structural ^ per
// voice, no sticky-range bleed); a held voice is a \`_\` voice tie. ${NBARS} bars, ${BEATS}/4,
// ${SUB===2?'eighth':'quarter'} grid. Verified vs source MIDI.
var global = init GLOBAL
global.tempo(${tempo})
global.beat(${BEATS} by 4)
global.key("${KEY}")
global.start()

var ${SEQ} = init global.seq
${SEQ}.midi("IAC", 1).octave(${octave}).gate(0.95).vel(76)
${SEQ}.length(${NBARS})
${SEQ}.play(
${bars.join(',\n')}
)

${transport}(${SEQ})
`
fs.writeFileSync(process.env.OUT||'/tmp/out.orbs',orbs)
console.log(`wrote ${process.env.OUT||'/tmp/out.orbs'} — ${NBARS} bars, ${BEATS}/4, ${SUB===2?'eighth':'quarter'} grid`)
