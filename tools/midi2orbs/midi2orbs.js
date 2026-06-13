const fs = require('fs')
const buf = fs.readFileSync(process.argv[2])
let p=0; const u32=()=>{const v=buf.readUInt32BE(p);p+=4;return v}; const u16=()=>{const v=buf.readUInt16BE(p);p+=2;return v}; const u8=()=>buf[p++]
p=4;u32();u16();const ntrk=u16();const div=u16()
const vlq=()=>{let v=0,c;do{c=u8();v=(v<<7)|(c&0x7f)}while(c&0x80);return v}
const notes=[]
for(let t=0;t<ntrk;t++){if(buf.toString('ascii',p,p+4)!=='MTrk')break;p+=4;const len=u32();const end=p+len;let tick=0,status=0;const on={}
 while(p<end){tick+=vlq();let b=buf[p];if(b&0x80){status=b;p++}const type=status&0xf0,ch=status&0x0f
  if(status===0xff){u8();const l=vlq();p+=l}else if(status===0xf0||status===0xf7){const l=vlq();p+=l}
  else if(type===0x90){const n=u8(),v=u8();if(v>0)on[n+'|'+ch]=tick;else{const k=n+'|'+ch;if(on[k]!=null){notes.push({tick:on[k],note:n,dur:tick-on[k],ch});delete on[k]}}}
  else if(type===0x80){const n=u8();u8();const k=n+'|'+ch;if(on[k]!=null){notes.push({tick:on[k],note:n,dur:tick-on[k],ch});delete on[k]}}
  else if(type===0xc0||type===0xd0){u8()}else{u8();u8()}}
 p=end}
const NBARS=8, bar=4*div, eighth=div/2, slots=NBARS*8, ROOT=67, IONIAN=[0,2,4,5,7,9,11]
const SCALE={0:[1,0],2:[2,0],4:[3,0],5:[4,0],7:[5,0],9:[6,0],11:[7,0],1:[1,1],3:[3,-1],6:[4,1],8:[5,1],10:[7,-1]}
const deg=n=>{const sem=((n-7)%12+12)%12;const[d,alt]=SCALE[sem];const nat=ROOT+IONIAN[d-1]+alt;return{d,alt,range:Math.round((n-nat)/12)}}
function grid(ch,top){const vn=notes.filter(e=>e.ch===ch&&e.tick<bar*NBARS);const sn=new Array(slots).fill(null)
 for(let s=0;s<slots;s++){const tk=s*eighth;const so=vn.filter(e=>e.tick<=tk+1&&e.tick+e.dur>tk+1);if(so.length){so.sort((a,b)=>top?b.note-a.note:a.note-b.note);sn[s]={note:so[0].note,onset:Math.round(so[0].tick/eighth)===s}}}return sn}
function emit(sn){let cur=0,out=[],bars=[];for(let s=0;s<slots;s++){const x=sn[s]
 if(x==null)out.push('0');else if(!x.onset)out.push('_');else{const g=deg(x.note);let tok=(g.alt<0?'b'.repeat(-g.alt):g.alt>0?'#'.repeat(g.alt):'')+g.d;if(g.range!==cur){tok+='^'+(g.range>=0?'+':'')+g.range;cur=g.range}out.push(tok)}
 if(s%8===7){bars.push('  ('+out.join(', ')+')');out=[]}}return bars.join(',\n')}
const mel=emit(grid(1,true)), inner=emit(grid(2,true)), bass=emit(grid(3,false))
const tempo=process.env.TEMPO||60, transport=process.env.TRANSPORT||'LOOP'
const orbs=`// Ravel — Pavane pour une infante défunte (M.19), opening 8 bars (3 voices).
// AUTO-TRANSCRIBED from the public-domain MIDI by tools/midi2orbs.js — mechanical
// pitch→degree(+^range) mapping in G major, eighth grid, _ = tie. (Verified: rendered
// pitches match the source MIDI.) The ^N juggling shows the octave-crossing friction
// of the degree model — a real finding for the pitch DSL.
var global = init GLOBAL
global.tempo(${tempo})
global.beat(4 by 4)
global.key("G")
global.start()

var piano = init global.seq
piano.midi("IAC", 1).octave(4).gate(0.95).vel(84)
piano.length(8)
piano.play(
${mel}
)

var inner = init global.seq
inner.midi("IAC", 2).octave(4).gate(0.85).vel(58)
inner.length(8)
inner.play(
${inner}
)

var bass = init global.seq
bass.midi("IAC", 3).octave(4).gate(0.95).vel(66)
bass.length(8)
bass.play(
${bass}
)

${transport}(piano, inner, bass)
`
fs.writeFileSync(process.env.OUT||'/tmp/pavane.orbs',orbs)
console.log('wrote '+(process.env.OUT||'/tmp/pavane.orbs')+' (tempo '+tempo+', '+transport+')')
