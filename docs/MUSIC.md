# The village gramophone

Seven instrumental pieces were made for CottageCode with **ElevenLabs Music
v2**, using original prompts for sparse, rounded chip tones, warm pads, and
quiet music-box melodies. No artist or existing track was used as a reference.

| Piece | When it plays |
|---|---|
| Mosslight Morning | Morning, 05:00–09:00 |
| Little Roads | Day, 09:00–17:00 |
| Lamplight | Dusk, 17:00–21:00 |
| After the Fireflies | Night, 21:00–05:00 |
| Pocket Signals | AppTown, morning/day |
| Between the Pages | MemTown, morning/day |
| The Clockmaker | VaultTown, morning/day |

Times use the device's local clock. The preview menu changes both light and
music. Location means Jack's feet in a town or the cottage he has entered;
selecting a distant inspector does not move the soundtrack. Unknown towns use
the shared time-of-day pieces. No geolocation or weather services are called.

Night uses a desaturated blue palette inspired by Game Boy Color scenes, with
moonlit paths and warm window light only where an agent is still working.
From 18:30, residents gather their recorded child agents and garden chickens,
then head indoors. Chickens close up in their coops; nonworking hosts tuck
under a blanket while working hosts remain at the workbench. Visiting and
talking still work at any hour. Bedtime is scenery, never a task-status update.
Previewing Day wakes the village; Dusk or Night starts the short homecoming.
Reduced motion immediately shows the settled scene. Homes and flocks retain
their task seeds across refreshes.
`npm run test:night` checks the rendered night colors, working windows, family
homecoming, and walking to a sleeping host to talk with E in real Chrome.

Each piece is about 65 seconds. Two native audio elements overlap loops and
crossfade between tracks, with a four-second delay to avoid changing songs at
every step along a town boundary. Playback starts off on every page load. The
default volume is 16%, reduced to 65% of that indoors and a further 25% while
the conversation panel is open. Hidden tabs release playback; returning resumes
only music explicitly enabled in that visit. Playback errors stop the music and
offer an explicit retry. Sound effects have their own switch.

When a browser ignores the media element's volume setting, a small Web Audio
gain stage preserves the same quiet level, crossfades, and conversation hush.
It still streams the bundled media directly; there is no fetch/decode path.
This addresses [Safari's media-volume limitation](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/Device-SpecificConsiderations/Device-SpecificConsiderations.html).

The bundled MP3s use 96 kbps stereo. A low-pass filter at 5.5 kHz softens their
top end, loudness normalization targets −20 LUFS, and short edge fades remove
clicks. The generated sources and private attempt receipts remain in ignored
`tmp/music-generation/`. Public prompts, generation dates, source IDs, processing
settings, and final file hashes are in [music-provenance.json](music-provenance.json).

## Authoring new music

Generation is a separate, manual paid operation. The app, tests, and deployment
never call ElevenLabs. With an existing `ELEVENLABS_API_KEY` in the environment:

```bash
node scripts/generate-music.mjs --generate morning
node scripts/prepare-music.mjs
```

The generator uses the [official compose endpoint](https://elevenlabs.io/docs/api-reference/music/compose)
with `model_id: music_v2` and `force_instrumental: true`. It records an attempt
before sending and refuses a duplicate ID. Inspect an existing receipt before
any deliberate replacement; an unconfirmed request may have consumed credits.
The preparation step requires `ffmpeg` and `ffprobe`, works only on confirmed
local generations, and performs no network requests. These are authoring tools,
not runtime dependencies.

`npm run test:ambience` checks the gramophone and postcards in real Chrome using
a temporary fictional feed. To verify a deployed sample village, pass
`-- --url https://autojack.ai/cottagecode/`. `npm test` covers lifecycle races,
loop overlap, visibility, volume, clocks, seeded scenery, and PNG boundaries.
