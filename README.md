# Jungle Sailor

A nocturnal, mystical boat ride through a narrow jungle waterway, built with
[three.js](https://threejs.org/). A paddler in an old wooden rowboat glides
down an endless winding creek under a full moon. Steer with the keyboard or
your thumb, gather the glowing moon-lotus blossoms, and change the weather
between a moonlit night, a warm dawn and overcast rain.

Everything is generated in the browser: the river and banks, the jungle, the
leaf textures, the moon, the boat, the paddler and the ambient sound. There are
no image, model or audio files.

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Paddle forward | `W` / `↑` | Drag up |
| Steer | `A` `D` / `←` `→` | Drag sideways |
| Back-paddle | `S` / `↓` | Drag down |
| Weather | `1` night · `2` dawn · `3` rain | Buttons, top right |
| Sound on/off | `M` | Speaker button |

The touch stick appears wherever you put your thumb. Dragging with the mouse
works the same way on desktop.

## What is in the scene

- **The paddler**: a bearded explorer in a fedora, linen shirt with rolled
  sleeves, leather vest, neckerchief, satchel and laced boots, built in code as
  one skinned mesh. The body is lofted through anatomical cross-sections and
  weighted smoothly over a 19-bone skeleton with forearm twist bones, so
  shoulders, elbows, wrists and knees bend without seams. The fists close round
  the shaft and the T-grip, and the clothing is laid out per pixel with skin,
  cloth, leather and brass shading. Two-bone IK drives the arms and legs; the
  body follows the stroke with torso rotation, lean, a slide along the thwart
  and breathing. The paddler works on the side that turns the boat the way you
  steer and switches sides as needed. When resting they look around, glance
  up at the moon, stretch at dawn, hunch in the rain and brace when the hull
  knocks a bank.
- **Stroke-driven boat physics**: thrust comes from the blade moving through
  the water, so the boat surges with each stroke and glides between them.
  Turning sweeps the boat round and back-paddling brakes it. Banks are solid.
- **The rowboat**: a pointed bow, broad clinker-planked sides, a flat transom,
  ribs, floorboards and thwarts. It floats slightly down in the water with a
  dry interior.
- **Water**: wind ripples are re-synthesised every frame from a sum of
  dispersive waves. A planar reflection mirrors the boat, the paddler and the
  trees, distorted by the surface. Moonlight breaks up across the water through
  a slope-distribution glitter model. A GPU height-field simulation travels with
  the boat, so the wake follows the real path, spreads and fades on its own.
  The paddle blade stirs it too.
- **Rain**: drops and their impact ripples come from the same per-cell
  timetable, so every ring belongs to a drop you can see land. The rings ride
  and bend with the waves.
- **Jungle**: canopy trees, buttressed giants, palms, tree ferns, banana
  plants, shrubs, ferns, reeds and hanging lianas sway in a gusting wind.
  They are streamed in chunks along the river and drawn with instancing.
- **Sky**: a detailed full moon with maria and ray craters, stars and a faint
  Milky Way, a low dawn sun, procedural clouds and height fog that hugs the
  water.
- **Moon lotus**: glowing blossoms float along the river. Paddle over one to
  gather it; the counter beside the distance keeps score.
- **Sound** (optional, off until enabled): water lapping, a swish that grows
  with speed, paddle splashes and drips, night insects and frogs, dawn birds,
  rain, and a chime for each blossom. All of it is synthesised with WebAudio.

## Development

Requires Node 20.19+ or 22.12+.

```bash
npm install
npm run dev      # local dev server
npm run build    # production build into dist/
npm run preview  # serve the production build
```

### URL parameters

Handy for testing and screenshots:

| Parameter | Effect |
| --- | --- |
| `weather=night\|dawn\|rain` | Start in a given weather |
| `quality=high\|low` | Force a render tier (phones default to `low`) |
| `dpr=1` | Fix the pixel ratio (turns off the adaptive resolution) |
| `z=-400` | Start further down the river |
| `cam=side\|front\|close\|top\|water\|figure\|back\|face\|hand` | Fixed inspection cameras |
| `view=refl\|mask\|normal\|slope\|waves\|fresnel` | Water debug views |

`window.__jungle.state` exposes the live state (distance, speed, weather,
paddler, audio level, frame rate), and the automated checks use it.

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` builds the site on every pull request. On
pushes to `main`, or when run manually, it also publishes `dist/` to GitHub
Pages.

One-time setup: in the repository go to **Settings → Pages** and set
**Source** to **GitHub Actions**. The build uses relative asset paths, so it
works from `https://<user>.github.io/<repo>/` without any configuration.

## Project layout

```
src/
  main.js              renderer, frame loop, passes, governor
  core/                seeded randomness and noise, mesh builder, quality tiers
  world/               river path, terrain chunks, boat, hull lines, sky, moon,
                       weather presets, follow camera, lotus blossoms
  water/               wave synthesis, wake simulation, planar reflection, water
  vegetation/          leaf atlas, plant generators, forest streaming, material
  character/           body kinematics, paddle stroke controller, paddler
  effects/             rain and fireflies
  audio/               procedural ambience
  ui/                  input (keys + touch stick) and HUD
```

## Browser support

Any current browser with WebGL 2 runs it: Chrome, Edge, Firefox and Safari 15+
on desktop, iOS and Android. Phones get a lighter render tier, and a
frame-time governor lowers the resolution if a device falls behind.

## License

MIT, see [LICENSE](LICENSE).
