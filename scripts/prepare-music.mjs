#!/usr/bin/env node
// Optimize previously generated files. This command never calls an API.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {MUSIC_SPECS} from './generate-music.mjs';

const run=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const input=join(root,'tmp/music-generation'),output=join(root,'src/audio'),manifest=[];
await mkdir(output,{recursive:true});
for(const track of MUSIC_SPECS){
  const receipt=JSON.parse(await readFile(join(input,track.id+'.json'),'utf8'));
  if(receipt.status!=='generated')throw new Error('No confirmed generation for '+track.id);
  const raw=join(input,track.id+'.mp3'),final=join(output,track.id+'.mp3');
  const probe=JSON.parse((await run('ffprobe',['-v','error','-show_format','-of','json',raw])).stdout);
  const duration=Number(probe.format.duration);
  if(!Number.isFinite(duration)||duration<60||duration>70)throw new Error('Unexpected duration: '+track.id);
  const filter='lowpass=f=5500,loudnorm=I=-20:TP=-3:LRA=7,afade=t=in:d=0.08,afade=t=out:st='+(duration-.3).toFixed(3)+':d=0.3';
  await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',raw,'-map_metadata','-1','-af',filter,'-ar','44100','-ac','2','-c:a','libmp3lame','-b:a','96k','-metadata','title='+track.title,'-metadata','artist=CottageCode · ElevenLabs',final]);
  const bytes=await readFile(final),sha256=createHash('sha256').update(bytes).digest('hex');
  manifest.push({id:track.id,title:track.title,phase:track.phase,...(track.town?{town:track.town}:{}),provider:'ElevenLabs',model:receipt.model,generatedAt:receipt.completedAt,songId:receipt.songId,durationSeconds:duration,bytes:bytes.length,sha256,prompt:receipt.request.prompt,processing:filter,format:'MP3 · 44.1 kHz stereo · 96 kbps'});
  process.stdout.write(track.id+': '+duration.toFixed(1)+'s, '+Math.round(bytes.length/1024)+' KB\n');
}
await writeFile(join(root,'docs/music-provenance.json'),JSON.stringify(manifest,null,2)+'\n');
