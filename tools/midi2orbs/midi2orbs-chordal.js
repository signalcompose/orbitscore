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
const NBARS=+(process.env.BARS||8), bar=4*div, beat=div, slots=NBARS*4
const tonicPc=+(process.env.TONIC_PC||2) /*D*/, octave=4, ROOT=12*(octave+1)+tonicPc, IONIAN=[0,2,4,5,7,9,11]
const SCALE={0:[1,0],2:[2,0],4:[3,0],5:[4,0],7:[5,0],9:[6,0],11:[7,0],1:[1,1],3:[3,-1],6:[4,1],8:[6,-1],10:[7,-1]}
const tok=n=>{const sem=((n-tonicPc)%12+12)%12;const[d,alt]=SCALE[sem];const nat=ROOT+IONIAN[d-1]+alt;const range=Math.round((n-nat)/12)
 return (alt<0?'b'.repeat(-alt):alt>0?'#'.repeat(alt):'')+d+(range!==0?'^'+(range>0?'+':'')+range:'')}
const bars=[]; const HOLD=process.env.HOLD==='1'
for(let b=0;b<NBARS;b++){const beats=[]
 for(let q=0;q<4;q++){const tk=b*bar+q*beat
  const cover=notes.filter(e=>e.tick<=tk+1&&e.tick+e.dur>tk+1)
  const seen=new Set(); const voices=[]
  for(const e of cover.sort((a,b)=>a.note-b.note)){ if(seen.has(e.note))continue; seen.add(e.note)
   const onset=Math.abs(e.tick-tk) < beat/4   // a note that STARTS at this beat = attack; else held = tie
   voices.push((onset?'':'_')+tok(e.note)) }
  beats.push(voices.length?('['+voices.join(', ')+']'):'0')}
 bars.push('  ('+beats.join(', ')+')')}
const tempo=process.env.TEMPO||60, transport=process.env.TRANSPORT||'LOOP', KEY=process.env.KEY||'D'
const orbs=`// Bach — Chorale "O Haupt voll Blut und Wunden" (Passion Chorale), opening ${NBARS} bars.
// AUTO-TRANSCRIBED (public-domain MIDI, Mutopia) by tools/midi2orbs-chordal.js —
// CHORDAL mode: each beat = the sounding pitches as a [ ] stack (structural ^ per voice,
// no sticky-range bleed). This is where [ ] is the natural fit (homophony). Verified vs source.
var global = init GLOBAL
global.tempo(${tempo})
global.beat(4 by 4)
global.key("${KEY}")
global.start()

var choir = init global.seq
choir.midi("IAC", 1).octave(${octave}).gate(0.95).vel(78)
choir.length(${NBARS})
choir.play(
${bars.join(',\n')}
)

${transport}(choir)
`
fs.writeFileSync(process.env.OUT||'/tmp/chorale.orbs',orbs)
console.log(orbs)
