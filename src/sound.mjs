/** Tiny opt-in sound vocabulary, synthesized locally without media downloads. */
export function createSound({contextFactory=null}={}){
  let context=null,enabled=false,ambience=true,alerts=true,enableVersion=0;
  const last=new Map(),voices=new Set();

  function finish(voice){
    if(voice.finished)return;
    voice.finished=true;voices.delete(voice);
    for(const source of voice.sources)source.onended=null;
    for(const node of voice.nodes){try{node.disconnect();}catch{}}
  }
  function stop(voice){
    if(voice.finished)return;
    for(const source of voice.sources){try{source.stop(context.currentTime);}catch{}}
    finish(voice);
  }
  function stopChannel(channel){
    for(const voice of [...voices])if(!channel||voice.channel===channel)stop(voice);
  }
  async function enable(value){
    const version=++enableVersion;
    enabled=!!value;
    if(enabled){
      const Constructor=globalThis.AudioContext||globalThis.webkitAudioContext;
      if(!contextFactory&&!Constructor){enabled=false;return false;}
      try{
        context ||= contextFactory?contextFactory():new Constructor();
        await context.resume();
        if(version===enableVersion&&context.state!=='running')enabled=false;
      }catch{if(version===enableVersion)enabled=false;}
    }else{
      // Suspended oscillators must not resume old syllables when sound returns.
      stopChannel();last.clear();
      if(context)await context.suspend().catch(()=>{});
    }
    return enabled;
  }
  function settings(kind,{distance=0,pan=0}={},cooldown=.8){
    const channel=['ready','blocked','done'].includes(kind)?'alerts':'ambience';
    if(!enabled||!context||context.state!=='running'||(channel==='alerts'?!alerts:!ambience))return null;
    const attenuation=Number.isFinite(distance)?Math.max(0,1-Math.max(0,distance)/220):0;
    if(!attenuation)return null;
    const now=context.currentTime;
    if(now-(last.get(kind)??-Infinity)<cooldown)return null;
    return {now,volume:attenuation*.045,pan:Number.isFinite(pan)?Math.max(-1,Math.min(1,pan)):0,channel};
  }
  function voiceFor(channel){
    const voice={nodes:[],sources:[],channel,finished:false};voices.add(voice);
    return {voice,node(n){voice.nodes.push(n);return n;},source(n){voice.sources.push(n);voice.nodes.push(n);n.onended=()=>finish(voice);return n;}};
  }
  function play(kind,options={}){
    const config=settings(kind,options,kind==='step'?.18:.8);if(!config)return false;
    const {now,volume,pan,channel}=config;
    const notes={step:[120,.025,'triangle'],door:[180,.15,'triangle'],quack:[390,.12,'square'],splash:[720,.12,'sine'],
      chirp:[880,.09,'sine'],talk:[440,.05,'square'],ready:[660,.3,'sine'],blocked:[220,.25,'triangle'],done:[520,.22,'sine']};
    const [frequency,duration,type]=notes[kind]||notes.chirp;
    const tracked=voiceFor(channel);
    try{
      const oscillator=tracked.source(context.createOscillator()),gain=tracked.node(context.createGain()),panner=tracked.node(context.createStereoPanner());
      oscillator.type=type;oscillator.frequency.setValueAtTime(frequency,now);
      oscillator.frequency.exponentialRampToValueAtTime(kind==='ready'?frequency*1.5:frequency*.55,now+duration);
      gain.gain.setValueAtTime(volume,now);gain.gain.exponentialRampToValueAtTime(.0001,now+duration);
      panner.pan.value=pan;
      oscillator.connect(gain).connect(panner).connect(context.destination);
      oscillator.start(now);oscillator.stop(now+duration+.02);last.set(kind,now);return true;
    }catch{stop(tracked.voice);return false;}
  }
  function murmur({seed=0,distance=0,pan=0}={}){
    const config=settings('murmur',{distance,pan},1.5);if(!config)return false;
    const {now,volume,channel}=config;
    // The seed determines a character's little melodic phrase. These vowel-like
    // tones are nonspeech: there is no text, recording, or hidden agent reasoning.
    let state=2166136261;
    for(const character of String(seed)){state=Math.imul(state^character.codePointAt(0),16777619)>>>0;}
    const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    const pitch=155+random()*115,count=5+Math.floor(random()*3);
    const melody=[0,2,5,7,9,-2,4],vowels=[[350,900],[500,1250],[700,1550],[430,1900],[560,1650]];
    const tracked=voiceFor(channel);
    try{
      const oscillator=tracked.source(context.createOscillator());
      const formantA=tracked.node(context.createBiquadFilter()),formantB=tracked.node(context.createBiquadFilter());
      const upperGain=tracked.node(context.createGain()),envelope=tracked.node(context.createGain());
      const softener=tracked.node(context.createBiquadFilter()),panner=tracked.node(context.createStereoPanner());
      oscillator.type='sawtooth';
      formantA.type='bandpass';formantA.Q.value=4;
      formantB.type='bandpass';formantB.Q.value=5;
      upperGain.gain.value=.4;
      softener.type='lowpass';softener.frequency.value=2700;softener.Q.value=.6;
      panner.pan.value=config.pan;
      oscillator.connect(formantA).connect(envelope);
      oscillator.connect(formantB).connect(upperGain).connect(envelope);
      envelope.connect(softener).connect(panner).connect(context.destination);
      envelope.gain.setValueAtTime(.0001,now);
      let onset=now;
      for(let i=0;i<count;i++){
        const duration=.085+random()*.065,gap=.035+random()*.025;
        const note=pitch*2**(melody[Math.floor(random()*melody.length)]/12);
        const [first,second]=vowels[Math.floor(random()*vowels.length)];
        oscillator.frequency.setValueAtTime(note*.95,onset);
        oscillator.frequency.exponentialRampToValueAtTime(note*1.025,onset+duration*.4);
        oscillator.frequency.exponentialRampToValueAtTime(note*(i===count-1?.83:.97),onset+duration);
        formantA.frequency.setValueAtTime(first,onset);
        formantA.frequency.linearRampToValueAtTime(first*.88,onset+duration);
        formantB.frequency.setValueAtTime(second,onset);
        formantB.frequency.linearRampToValueAtTime(second*1.08,onset+duration);
        const peak=Math.max(.0002,volume*(.55+random()*.2));
        envelope.gain.setValueAtTime(.0001,onset);
        envelope.gain.linearRampToValueAtTime(peak,onset+.016);
        envelope.gain.exponentialRampToValueAtTime(Math.max(.00015,peak*.5),onset+duration*.65);
        envelope.gain.exponentialRampToValueAtTime(.0001,onset+duration);
        onset+=duration+gap;
      }
      oscillator.start(now);oscillator.stop(onset+.025);last.set('murmur',now);return true;
    }catch{stop(tracked.voice);return false;}
  }
  return {
    enable,play,murmur,get enabled(){return enabled;},
    set ambience(v){ambience=!!v;if(!ambience)stopChannel('ambience');},
    set alerts(v){alerts=!!v;if(!alerts)stopChannel('alerts');},
  };
}
