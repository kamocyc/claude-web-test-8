# Infinite Rail — 無限鉄道

An endlessly generated Japanese railway, driven from the cab. Every route is
built at run time from a single seed: the alignment, the earthworks, the
overhead line, the stations and their names, the timetable you are trying to
keep, and the countryside it all runs through — coast, mountain, forest, rice
paddy, riverside, suburb and city.

Written in TypeScript on top of three.js. There are no art assets: every
texture is synthesised on a canvas at load time and every mesh is generated
from code, so the whole game is about 1 MB of JavaScript. The interface is
available in English and Japanese.

**Play it:** https://kamocyc.github.io/claude-web-test-8/

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production bundle into dist/
npm run preview    # serve the production build
```

Pushing to `main` builds the bundle and publishes it to GitHub Pages
(`.github/workflows/deploy-pages.yml`).

## Driving

The controls follow BVE convention, with the two handles independent as they
are on Japanese two-handle stock: moving the brake never drags the master
controller with it — traction is cut electrically instead.

| Key | |
| --- | --- |
| `Z` / `/` | Master controller notch up (N → P1 … P5) |
| `A` / `:` | Master controller notch down |
| `.` | Brake step on (B1 … B8) |
| `,` | Brake step off |
| `Q` / `@` | Emergency brake |
| `↑` | Reverser towards forward (only at a stand) |
| `↓` | Reverser towards reverse (only at a stand) |
| `Enter` | Horn (low) |
| `Shift` + `Enter` | Horn (high) |
| `C` | Change camera; `Shift`+`C` flips the window view to the other side |
| `F` | Automatic driving on/off |
| `B` | Skip ahead to the next landscape |
| `U` | Hide the cab display |
| `J` | Switch between English and 日本語 |
| `L` | Headlights |
| `T` | Skip the clock forward 45 minutes (the timetable moves with it) |
| `W` | Cycle the weather |
| `P`, `Esc` | Pause |
| `F3` | Performance overlay |
| Mouse drag | Look around |

The job is the same as a real driver's: run at or below the permitted speed,
stop with the cab against the stopping marker at the far end of each platform,
and arrive on the minute. Score comes from stopping accuracy and punctuality;
overspeeding, harsh handling and emergency brake applications cost you.

Six views: the cab, a passenger window looking out sideways, a chase camera, a
fixed lineside camera that picks a new spot for each pass, the nose, and the
roof.

**Automatic driving** (`F`) hands the train to an ATO that works to a target
speed built from the line limit ahead and the braking curve to the next
stopping mark, moving a notch at a time so the ride stays smooth. Touching any
handle takes control back.

**Skip to the next landscape** (`B`) runs the service forward to wherever the
line next changes character — out of the forest and onto the coast, say —
carrying the timetable with it so you arrive still running to time.

`?seed=12345` fixes the route and `?time=15.5` fixes the departure hour, so a
particular line can be shared or replayed. `?capture=1` pins the drawing buffer
and disables dynamic resolution for screenshot tooling.

## How the world is built

**The alignment** (`src/world/TrackPath.ts`) is integrated sample by sample at
2 m intervals from a rate-limited curvature and gradient. Rate limiting the
curvature is exactly what a clothoid transition does, so straights run into
circular curves progressively, gradients are joined by vertical curves, and
cant is applied in proportion to `v²/R`. Because the geometry is generated
forward from its own state, the route can be extended for ever and sampled at
any chainage; nothing is ever stored twice.

The same generator places stations (with procedurally assembled kanji/romaji
names), signals, level crossings, speed restrictions, tunnels and bridges, and
writes a timetable as it goes.

**Biomes** (`src/world/Biome.ts`) are chosen by a Markov chain so a route reads
like a real regional line — the coast runs for a while, mountains lead into
forest, cities are approached through suburbs. A biome sets the landform, the
line speed, how tight the curves get, what grows and what is built there, and
the colour of the ground. Transitions cross-fade over 900 m, and everything —
terrain height, scatter density, fog — is a blend of the biomes in play.

**The ground** (`src/world/TerrainField.ts`) is a single pure function of world
position. Anything that needs to know how high the land is asks it, which is
why the detailed track-space corridor, the LOD terrain tiles, the sea surface
and every scattered tree agree with each other exactly. The railway's own
earthworks — embankment, cutting, tunnel cover, station forecourt — are applied
inside that function, so the formation is part of the terrain rather than
something laid on top of it.

Terrain is drawn as concentric rings of tiles (`TerrainTiles.ts`), 4 m grid
close in and coarsening by powers of two out to the fog limit, with a downward
skirt hiding the LOD seams — plus a fine track-space strip that resolves the
earthworks the tiles cannot.

**Chunks** (`src/world/Chunk.ts`) cover 250 m of line each and carry the
permanent way, overhead line, signalling, stations, structures and scenery.
They are built ahead of the train inside a per-frame time budget and released
behind it, so entering a city never stalls a frame.

## Rendering

- Analytic sky dome: gradient, Mie sun halo, procedural cloud deck, stars and a
  moon, all driven by the time of day. It also bakes into a prefiltered
  environment map every few seconds, which is what lights the metals, the
  glazing and the painted bodysides.
- Sun and sky are the only lights: one shadow-casting directional light, a
  small hemisphere fill, and image based lighting for everything else.
- Water is a custom shader carrying a per-vertex depth attribute, so waves
  shrink, colour deepens and foam appears at the shoreline without needing a
  depth pre-pass. Used for the sea, river crossings, canals and flooded paddies.
- Post: bloom on genuine highlights only, then a grade pass with lateral
  chromatic aberration, split toning, vignette, film grain, windscreen glare
  and a wet-glass term for rain.
- Vegetation and grass sway in a shared wind field; instance colours give a
  forest its variation without a single unique material.

## The train

`src/train/TrainPhysics.ts` runs a proper longitudinal model: a tractive effort
curve that is constant to base speed and then constant power, Davis running
resistance, gradient and curve resistance, and a brake system with separate
build-up and release lags. A four-car EMU at P5 accelerates at about
2.8 km/h/s and stops from 90 km/h in a bit under 400 m on B8 — so you brake for
a curve long before you can see it, and a 25 ‰ climb is something you feel.

The consist is placed from its bogie centres, which is what makes a rake swing
properly through a curve. The cab is modelled around the driver's eye, and
trains you meet on the opposite road are real trains, not a sound effect.

## Sound

Everything is synthesised in the Web Audio graph (`src/audio/AudioEngine.ts`):
a VVVF-style oscillator bank whose frequency tracks the motor, filtered noise
for rolling and wind, brake squeal and release hiss, a compressor that cuts in
now and then, two horns, crossing bells, and a short feedback delay that opens
up when a tunnel closes in.

Rail joints are fired by distance travelled rather than by a timer, and each
joint is struck four times — both wheelsets of the leading bogie, then both of
the trailing one — which is what turns a tick into the familiar
*gatan-goton* as the spacing closes up with speed.

## Layout

```
src/
  core/       engine, render graph, input, settings, maths
  world/      route generation, biomes, terrain, sky, weather, streaming
  builders/   geometry: permanent way, stations, structures, scenery
  materials/  procedural textures, shared materials, water shader
  train/      physics, rolling stock, cab, opposing traffic
  game/       game loop, journey and scoring, cameras
  ui/         cab display, dials, menus
  audio/      synthesised sound
tools/        headless screenshot capture and smoke test
```

## Notes

Quality auto-detects and can be changed on the title screen; the renderer also
scales its drawing buffer to hold frame rate without popping scene detail.
Requires WebGL 2.
