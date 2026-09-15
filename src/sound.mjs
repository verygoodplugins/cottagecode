/** Tiny opt-in sound vocabulary, synthesized locally without media downloads. */
export function createSound(){
  let context=null,enabled=false,ambience=true,alerts=true;
  const last=new Map();
  async function enable(value){
    enabled=!!value;
    if(enabled){
      const Constructor=globalThis.AudioContext||globalThis.webkitAudioContext;
      if(!Constructor){enabled=false;return false;}
      context ||= new Constructor();
      try{await context.resume();}catch{enabled=false;}
    }else if(context) await context.suspend().catch(()=>{});
    return enabled;
  }
  function play(kind,{distance=0,pan=0}={}){
    const isAlert=['ready','blocked','done'].includes(kind);
    if(!enabled||!context||context.state!=='running'||(isAlert?!alerts:!ambience)) return false;
    const now=context.currentTime;
    if(now-(last.get(kind)??-10)<(kind==='step'?.18:.8))return false;
    last.set(kind,now);
    const volume=Math.max(0,1-distance/220)*.045;
    if(!volume)return false;
    const notes={step:[120,.025,'triangle'],door:[180,.15,'triangle'],quack:[390,.12,'square'],splash:[720,.12,'sine'],
      chirp:[880,.09,'sine'],talk:[440,.05,'square'],ready:[660,.3,'sine'],blocked:[220,.25,'triangle'],done:[520,.22,'sine']};
    const [frequency,duration,type]=notes[kind]||notes.chirp;
    const oscillator=context.createOscillator(),gain=context.createGain(),panner=context.createStereoPanner();
    oscillator.type=type;oscillator.frequency.setValueAtTime(frequency,now);
    oscillator.frequency.exponentialRampToValueAtTime(kind==='ready'?frequency*1.5:frequency*.55,now+duration);
    gain.gain.setValueAtTime(volume,now);gain.gain.exponentialRampToValueAtTime(.0001,now+duration);
    panner.pan.value=Math.max(-1,Math.min(1,pan));
    oscillator.connect(gain).connect(panner).connect(context.destination);
    oscillator.start(now);oscillator.stop(now+duration+.02);
    oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();panner.disconnect();};return true;
  }
  return {enable,play,get enabled(){return enabled;},set ambience(v){ambience=!!v;},set alerts(v){alerts=!!v;}};
}
