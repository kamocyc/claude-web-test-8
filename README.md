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
| `←` / `→` | Slide the view sideways — lean across the cab to see round a pillar |
| `R` | Put the view back where it started |
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
| Right-button drag | Slide the view sideways |

The job is the same as a real driver's: run at or below the permitted speed,
stop with the cab against the stopping marker at the far end of each platform,
and arrive on the minute. Score comes from stopping accuracy and punctuality;
overspeeding, harsh handling and emergency brake applications cost you.

Six views: the cab, a passenger window looking out sideways, a chase camera, a
fixed lineside camera that picks a new spot for each pass, the nose, and the
roof.

**Automatic driving** (`F`) hands the train to an ATO that works out the
deceleration the road ahead actually calls for — the stopping mark, a
restriction coming up, the line limit — and picks the brake notch that produces
it, moving a notch at a time so the ride stays smooth. It brings the train to a
stand within half a metre of the marker. Touching any handle takes control
back.

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
earthworks the tiles cannot. Each ring is punched hollow where the ring inside
it already covers the ground, overlapping it by exactly one of its own cells:
two meshes of different resolution do not agree between their vertices, so a
solid ring shows through the one inside it as flat facets and z-fighting.

Track space, though, only exists where there is track. Every query carries how
far it fell past the end of the generated route, and everything the railway did
to the ground — the formation, a station forecourt, the lineside drain, the
hillside a tunnel is bored through — fades out with it, so the horizon is never
shaped by whatever happened to be at the last sleeper. The route itself is
integrated out to the fog limit rather than to the last chunk, which is much
cheaper than it sounds and is what gives the distance real biomes to be.

**Rivers** (`River.ts`) are the one part of the landscape that is not the
railway's, so they are not described in the railway's coordinates. A crossing
is resolved once into a world-space axis — a point, a downstream direction, a
surface level and a fall — and the valley, the braided gravel bed and the water
drawn on it are all functions of world position after that. The bed is combined
with the natural ground by taking the lower of the two, never by replacing it,
so a river cuts a gorge through the mountains and a shallow trench across a
plain and can never raise a wall of its own across a hillside.

**Anything standing on the ground** — a house, a tree, a rice field, a fence —
is placed in a world-aligned frame at the height the terrain actually reports,
never in the track frame. The track frame is rolled by the cant and tilted by
the gradient; an offset of a couple of hundred metres along its right axis
lands tens of metres above or below the ground, which is enough to hang a whole
neighbourhood in the air over a canted curve. Buildings read the ground at the
four corners of their own footprint, refuse a plot too steep to build on, stand
on the high corner and carry the fall on a concrete stem wall. Land is claimed
before it is built on (`Sites.ts`), and the road, the water and the fields are
functions every builder asks before it places anything — which is what keeps
houses out of the carriageway and out of the river.

**Tunnels** are the one thing a height field cannot express: ground that arches
over the line. So it does not try. The hillside a tunnel is driven through
rises over the last 170 m of the approach — which turns the run in to the
portal into a cutting that deepens naturally — and through the bore itself the
ground keeps the formation, with a slot left open along the line that widens
from exactly the width of the approach cutting at the portal to what the bore
needs a few metres in. `buildTunnels` then caps that slot with a piece of
hillside cut to the same heights, so it seals without a seam, and the portal
head wall is the face of that cap with the arch punched through it.

**Stations** (`StationBuilder.ts`) are built to the Japanese standards rather
than to a silhouette: a 1,100 mm platform with a precast coped edge and the
yellow warning blocks — dots for the drop, ribs on the safe side — set 400 mm
back from it, a steel canopy on a single row of columns with the roof
cantilevered both ways and drained to a gutter at the back, name boards facing
the arriving train, a hanging board and an amber departure indicator under the
canopy, benches turned across the platform, a drinks machine, a bin and a
timetable frame. A station building with a deep-eaved hipped roof fronts the
forecourt, a covered walkway and a flight of steps link it to the platform, and
where the route calls for one a glazed footbridge crosses the line.

**Level crossings** are the Japanese arrangement: on each approach, on the
left of the carriageway as a driver meets it, one striped mast carries the
crossbuck, two red lamps that flash alternately, the direction indicator, the
bell and the machine whose arm swings down across the road — which puts the two
masts diagonally opposite each other. The arm lies along the line and lifts
about the track's lateral axis, so it blocks the road rather than the railway;
between the rails the road is carried on panels with the flangeway left open
beside each one.

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
- Vegetation and grass sway in a shared wind field; instance colours and three
  generated crown shapes per species give a forest its variation without a
  single unique material.
- The ground samples its sheet at three scales — crisp underfoot, working, and
  very large for field-to-field colour — and projects rock sideways on anything
  steep, so a cutting shows strata rather than a smeared plan view.
- Facades scale their texture from the instance's own size, so a four storey
  block and a twenty storey tower have floors the same height.

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

**The stock** (`TrainModel.ts`) is a modern JR commuter EMU worked out from its
own dimensions: 20 m over the couplers, a 2,950 mm laser-welded stainless
shell with the beading rolled along it, four 1,320 mm sliding doors a side, a
single air conditioner on the roof and a single-arm pantograph on alternate
cars. Everything is measured from the rail head, which is the datum the track
and the platforms use as well, so the door threshold lands level with a
1,100 mm platform and the pantograph shoe reaches exactly the height the
contact wire is strung at — neither is tuned against the other.

The shell is swept in two strips, below the windows and above them, which
leaves the window band genuinely open rather than papered over with dark
panels: doors, glazing and pillars fill it, you can see the saloon through the
glass, and the lighting reads through it after dark. Underneath, a bolsterless
bogie carries coned wheels with real flanges, disc brakes, coil primary
suspension and an air spring a side; the traction equipment hangs on one side
of the underframe and the auxiliaries and reservoirs on the other. The cab
front is a moulded mask with a two-piece raked windscreen, an emergency
gangway door offset to the driver's right, lamp clusters low in each corner and
a skirt over the coupler — and the windscreen is a genuine aperture through it,
because the driver has to see out.

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
tools/        headless screenshot capture, smoke test and landscape audits
```

## Notes

Quality auto-detects and can be changed on the title screen; the renderer also
scales its drawing buffer to hold frame rate without popping scene detail.
Requires WebGL 2.

`tools/groundcheck.mjs` audits the landscape rather than a picture of it: it
takes the world position of everything a chunk built, asks the terrain how high
the ground is there, and reports the distribution of the error. A tree fifteen
metres in the air is only obvious from the right angle, so this is the check
that does not depend on catching it in a screenshot.
`tools/rivershot.mjs` photographs the first river crossing on a route, which is
where the terrain, the bridge and the water surface all have to agree at once.

`tools/model.html` is a turntable: it stages one hand-built model at a time — a
car, a station, a level crossing, a street — against a neutral background, and
`tools/modelshot.mjs` steps a camera round it and writes a frame per view. The
game itself takes half a minute to settle before a chunk is worth photographing,
which is far too slow a loop for judging whether a bogie reads as a bogie, so
this exists to shorten it to a second or two:

```bash
npm run dev
node tools/modelshot.mjs cab-car     # also: car, station, crossing, buildings
```
