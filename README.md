# RoboClaw Cardiac

A 3D surgical planning and precision-simulation suite for robotic heart surgery. Two full
procedures are modelled step by step, and every cut, stitch and measurement is scored against
the surgical plan so a human hand can be compared directly with robotic execution.


**Live:** https://mnguyen36.github.io/roboclaw-cardiac/

## Running it

```
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production bundle into dist/
```

First load spends a few seconds generating the anatomy in a Web Worker. The result is cached in
IndexedDB, so later loads of a production build are instant.

## The two procedures

**Coronary artery bypass (LIMA to LAD).** A 72% proximal LAD stenosis in a 68-year-old. Ten steps
from conduit choice through port placement, mammary harvest, cardioplegic arrest, the 5 mm
arteriotomy, a 14-bite running anastomosis, transit-time flow measurement and weaning from bypass.

**Mitral valve repair (flail P2).** A ruptured chord with severe regurgitation in a 54-year-old.
Thirteen steps: right-sided access, left atriotomy, valve exposure, caliper analysis, triangular
resection of P2, leaflet re-approximation, two PTFE neochordae with adjustable length, ring sizing
and implantation, and a saline competence test that produces a regurgitant jet if the repair is off.

## Finding your way around

A guidance cue marks the single most useful control at each moment: the procedure list on
first load, the answer options on a decision step, the button that arms a precision task,
then `Next step` once the step is satisfied. It scrolls the control into view if it has
fallen below the fold, and dismissing it once turns hints off for good (Settings brings
them back).

**Exploded view** lifts the coronary and venous tree radially off the heart and ghosts the
myocardium behind it, with every vessel labelled. Picking is suspended while it is open,
because the displacement happens in the vertex shader and the pickable geometry stays put.

## What gets measured

| Task | Metrics |
| --- | --- |
| Incision | mean and maximum deviation from plan, length, endpoint error, tremor residual |
| Sutures | mean and largest placement error, bite spacing uniformity |
| Calipers | measured versus reference distance |
| Neochordae | length error (residual prolapse or restriction), anchoring accuracy |

Scores are lenient to half the tolerance, then fall off to zero weight at twice it. The case
report aggregates every step and exports as JSON.

## Control modes

- **Human hand** applies simulated physiological tremor, 8 to 12 Hz at roughly 0.4 mm, to the tip.
- **Robot-assisted** filters tremor and scales hand motion down, as a surgical console does.
- **Autonomous robot** executes the planned path itself while you supervise.

The same task scored under each mode is the point of the app: on a 2 mm coronary artery, the
difference between a filtered and an unfiltered hand is the difference between a patent graft and
a revision.

## How the anatomy is built

There is no imported mesh. `src/scene/heartCompute.ts` sculpts the chambers and great vessels as a
signed distance field, so structures blend into each other the way real tissue does, then carves
the interventricular and atrioventricular grooves as smooth subtractions. The surface is
polygonised with indexed marching cubes over a hierarchically sampled grid (about 133k triangles),
painted with per-vertex colour for myocardium, atria, arterial and venous wall and epicardial fat,
and displaced with fractal noise for surface relief. Coronary centrelines are projected onto the
resulting epicardium and built as variable-radius tubes, including the LAD plaque.

The mitral valve (`src/scene/MitralValve.ts`) is a separate parametric model: a saddle-shaped
annulus, an anterior leaflet, a three-scalloped posterior leaflet, chordae fanning from two
papillary muscles, and state for prolapse, resection, neochord length and ring seating.

Contraction is a vertex-shader deformation driven by one shared uniform set, so chambers,
coronaries and grafts all move together on the cardiac cycle from `src/app/physiology.ts`, which
also drives the ECG and arterial pressure traces on the monitor.

## Layout

```
src/scene/      anatomy generation, SDF primitives, marching cubes, valve, instruments, overlays
src/surgery/    procedure definitions and the measured task types
src/app/        orchestrator, physiology, state
src/ui/         shell, monitor, icons
src/dev/        console harness (dev only, load with ?harness)
```

## Note

This is an engineering and educational simulation, not a clinical tool or a substitute for
surgical training. Anatomy is procedurally approximated, not patient-derived.
