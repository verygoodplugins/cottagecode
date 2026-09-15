// Static assets only. Generation is a separate, manual authoring step.
export const MUSIC_TRACKS = Object.freeze([
  {id:'morning',title:'Mosslight Morning',phase:'morning',url:new URL('./audio/morning.mp3',import.meta.url).href,duration:65},
  {id:'day',title:'Little Roads',phase:'day',url:new URL('./audio/day.mp3',import.meta.url).href,duration:65},
  {id:'dusk',title:'Lamplight',phase:'dusk',url:new URL('./audio/dusk.mp3',import.meta.url).href,duration:65},
  {id:'night',title:'After the Fireflies',phase:'night',url:new URL('./audio/night.mp3',import.meta.url).href,duration:65},
  {id:'app-town',title:'Pocket Signals',phase:['morning','day'],town:'AppTown',url:new URL('./audio/app-town.mp3',import.meta.url).href,duration:65},
  {id:'mem-town',title:'Between the Pages',phase:['morning','day'],town:'MemTown',url:new URL('./audio/mem-town.mp3',import.meta.url).href,duration:65},
  {id:'vault-town',title:'The Clockmaker',phase:['morning','day'],town:'VaultTown',url:new URL('./audio/vault-town.mp3',import.meta.url).href,duration:65},
].map(Object.freeze));
