#!/usr/bin/env node
/** Manual asset generation only. Never runs in the app, build, or test suite. */
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const STYLE='Original instrumental background music for a quiet pixel cottage village. Very restrained low-bit ambient game music, rounded triangle-wave bass, soft filtered pulse-wave plucks, tiny sine-wave music-box notes, a warm faint pad. Slow 64 BPM, gentle G major and E minor colors. Only two or three soft notes at a time, generous rests, delicate dynamics, simple unhurried motifs. Calm and cozy, unobtrusive enough to read and concentrate. No vocals, no speech, no drums, no snare, no sharp high frequencies, no harsh bitcrushing, no busy arpeggios, no loud lead, no risers or drops. Keep an even texture from start to finish suitable for a gentle crossfade loop; no big intro, climax, or final cadence. The music should feel like a small mechanical music box heard from the next room. ';
export const MUSIC_SPECS=[
  {id:'morning',title:'Mosslight Morning',phase:'morning',direction:'Early morning sunlight on a wooden floor. A gently curious three-note plucked motif above soft sustained harmony, a little hopeful movement, very sparse and tender.'},
  {id:'day',title:'Little Roads',phase:'day',direction:'A peaceful afternoon in the village. A few rounded 8-bit plucks answer one another, supported by a quiet warm triangle bass. Leisurely, bright but never energetic.'},
  {id:'dusk',title:'Lamplight',phase:'dusk',direction:'Golden dusk and cottage lamps coming on. Slower-feeling phrases, warm suspended chords, wistful tiny music-box notes with long soft tails. A very gentle winding down.'},
  {id:'night',title:'After the Fireflies',phase:'night',direction:'Still night beside a small pond. The sparsest arrangement: distant rounded bell notes, a low soft pad, tiny falling two-note phrases separated by silence. Deeply restful and quiet, no tension.'},
  {id:'app-town',title:'Pocket Signals',phase:['morning','day'],town:'AppTown',direction:'A cozy workshop with little phones and computers. Small soft digital bleeps in a leisurely call and response, muted rounded square waves, a playful but very sparse melody. Never imitate notification or alarm sounds.'},
  {id:'mem-town',title:'Between the Pages',phase:['morning','day'],town:'MemTown',direction:'A hushed cottage library lined with books. Barely-there round chiptune piano notes and a gentle page-like chord progression. Reflective, spacious, soothing; slightly slower than the other village pieces.'},
  {id:'vault-town',title:'The Clockmaker',phase:['morning','day'],town:'VaultTown',direction:'A tiny clock repair shop. Soft music-box pin notes and rounded plucked tones form a delicate clockwork motif, widely spaced. A tender mechanical lullaby with no literal ticking sound and no percussion.'},
];

async function generate(id){
  const spec=MUSIC_SPECS.find(track=>track.id===id);
  if(!spec)throw new Error('Choose a track: '+MUSIC_SPECS.map(track=>track.id).join(', '));
  if(!process.env.ELEVENLABS_API_KEY)throw new Error('ELEVENLABS_API_KEY is not configured.');
  const directory=join(ROOT,'tmp','music-generation');
  await mkdir(directory,{recursive:true});
  const receiptPath=join(directory,id+'.json'),audioPath=join(directory,id+'.mp3');
  try{await access(receiptPath);throw new Error('An attempt already exists for '+id+'. Inspect its receipt before generating again.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const body={prompt:STYLE+spec.direction,music_length_ms:65000,model_id:'music_v2',force_instrumental:true};
  const receipt={...spec,provider:'ElevenLabs',model:body.model_id,requestedAt:new Date().toISOString(),status:'requested',request:body};
  await writeFile(receiptPath,JSON.stringify(receipt,null,2));
  let response;
  try{
    response=await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192',{method:'POST',headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY,'content-type':'application/json',accept:'audio/mpeg'},body:JSON.stringify(body),signal:AbortSignal.timeout(240000)});
    if(!response.ok){
      const error=await response.text();
      await writeFile(receiptPath,JSON.stringify({...receipt,status:'rejected',httpStatus:response.status,error:error.slice(0,1600)},null,2));
      throw new Error('ElevenLabs rejected '+id+' (HTTP '+response.status+'): '+error.slice(0,1000));
    }
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length<1000)throw new Error('ElevenLabs returned an incomplete audio file.');
    await writeFile(audioPath,bytes);
    const result={...receipt,status:'generated',completedAt:new Date().toISOString(),songId:response.headers.get('song-id'),requestId:response.headers.get('request-id'),bytes:bytes.length};
    await writeFile(receiptPath,JSON.stringify(result,null,2));
    process.stdout.write(JSON.stringify({id,title:spec.title,status:'generated',bytes:bytes.length,audioPath})+'\n');
  }catch(error){
    const saved=JSON.parse(await readFile(receiptPath,'utf8'));
    if(saved.status==='requested')await writeFile(receiptPath,JSON.stringify({...saved,status:'unconfirmed',error:String(error.message).slice(0,1000)},null,2));
    throw error;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--generate')throw new Error('Manual paid generation: node scripts/generate-music.mjs --generate <track-id>');
  generate(args[1]).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
}
