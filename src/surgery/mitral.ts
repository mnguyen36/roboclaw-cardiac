/**
 * Mitral valve repair for a flail P2 segment: triangular resection, neochordae and
 * annuloplasty ring, performed through a right-sided approach with the robot.
 */
import * as THREE from 'three';
import type { ProcedureDef, SurgeryContext } from './types';
import { IncisionTask, PointsTask, MeasureTask, NeochordTask, ChoiceTask, heartSurface, meshSurface, type PointTarget } from './tasks';
import { icons } from '../ui/icons';
import { wait } from '../app/physiology';
import { MitralValve } from '../scene/MitralValve';

const UP = new THREE.Vector3(0, 1, 0);

function valveOf(ctx: SurgeryContext): MitralValve {
  if (!ctx.valve) throw new Error('valve scene not ready');
  return ctx.valve;
}

/** World-space point on the valve group. */
function w(ctx: SurgeryContext, p: THREE.Vector3): THREE.Vector3 {
  return valveOf(ctx).group.localToWorld(p.clone());
}

function surgeonView(ctx: SurgeryContext, distance = 8) {
  const target = w(ctx, new THREE.Vector3(0, -0.4, 0.15));
  const dir = new THREE.Vector3(-0.3, 1, 0.5).normalize();
  return { position: target.clone().addScaledVector(dir, distance), target, fov: 32 };
}

/** Planned left atriotomy: on the left atrium just behind the interatrial groove, anterior to the right pulmonary veins. */
function atriotomyPlan(ctx: SurgeryContext): { points: THREE.Vector3[]; normals: THREE.Vector3[] } {
  const points: THREE.Vector3[] = [], normals: THREE.Vector3[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const model: [number, number, number] = [-0.29 - 0.06 * t, 0.68 - 0.54 * t, -0.41 - 0.1 * t];
    const p = ctx.heart.surfacePoint(model, 0);
    points.push(p);
    normals.push(ctx.heart.surfaceNormal(p));
  }
  return { points, normals };
}

export const mitralProcedure: ProcedureDef = {
  id: 'mitral',
  name: 'Mitral valve repair',
  short: 'Flail P2: resection, neochordae, ring',
  patient: '54-year-old, severe degenerative mitral regurgitation',
  indication: 'Ruptured chord to the middle scallop of the posterior leaflet (P2) with a flail segment and severe regurgitation. Dilated annulus, normal ventricle.',
  icon: icons.valve,
  steps: [
    {
      id: 'plan',
      title: 'Case review and repair strategy',
      short: 'Echo findings, Carpentier type II',
      instrument: 'Planning console',
      description: [
        'The mitral valve sits between the left atrium and left ventricle. Its two leaflets are tethered to the papillary muscles by fine chords. When a chord ruptures, that part of the leaflet flails back into the atrium during each beat and blood leaks backwards.',
        'On echo this patient has a flail P2 segment with severe regurgitation and a dilated annulus. Repair is strongly preferred over replacement in degenerative disease because it preserves the patient\'s own valve and ventricular function.',
      ],
      note: 'Pick the repair strategy. The valve is approached from the right side of the chest, through the left atrium.',
      labels: ['la', 'ra', 'svc', 'ivc', 'pv'],
      pose: (ctx) => { const c = ctx.heart.heart.geometry.boundingSphere!.center; return { position: c.clone().add(new THREE.Vector3(-26, 10, -16)), target: c.clone().add(new THREE.Vector3(0, 2, -2)) }; },
      task: (ctx) => new ChoiceTask(ctx, {
        title: 'Choose the repair',
        instructions: 'What is the best operation for a flail P2 with a ruptured chord?',
        options: [
          { id: 'resect', title: 'Triangular resection, neochordae and annuloplasty ring', desc: 'Remove the flail segment, re-suspend the leaflet with artificial chords, stabilise the annulus', score: 100, feedback: 'This is the classic and most durable approach for posterior leaflet prolapse, with repair rates above 95% in experienced centres.' },
          { id: 'ring', title: 'Annuloplasty ring only', desc: 'Reduce the annulus without addressing the flail segment', score: 35, feedback: 'The ring alone leaves the flail segment untreated. Regurgitation would persist or recur early.' },
          { id: 'replace', title: 'Mechanical valve replacement', desc: 'Excise the valve and implant a prosthesis', score: 45, feedback: 'Replacement is reserved for valves that cannot be repaired. It commits the patient to lifelong anticoagulation and loses ventricular support from the chordae.' },
          { id: 'clip', title: 'Transcatheter edge-to-edge clip', desc: 'Percutaneous clip joining the leaflet edges', score: 65, feedback: 'A reasonable option for patients too frail for surgery. In a fit 54-year-old, surgical repair gives a better and more durable result.' },
        ],
      }),
    },
    {
      id: 'access',
      title: 'Right-sided access and docking',
      short: 'Ports in the right chest, working through the 4th space',
      instrument: 'Robotic ports, atrial retractor',
      description: [
        'The heart is approached from the patient\'s right side. A small working port in the fourth intercostal space and three robotic ports give access to the right atrium and the groove between the two atria.',
        'The pericardium is opened in front of the phrenic nerve and stay sutures pull it back to expose the right side of the heart.',
      ],
      labels: ['ra', 'la', 'svc', 'ivc', 'pv'],
      pose: (ctx) => { const c = ctx.heart.heart.geometry.boundingSphere!.center; return { position: c.clone().add(new THREE.Vector3(-24, 9, -14)), target: c.clone().add(new THREE.Vector3(-1, 2.5, -2.5)) }; },
      action: {
        label: 'Dock the robot',
        doneLabel: 'Robot docked',
        run: async (ctx) => {
          const plan = atriotomyPlan(ctx);
          const mid = plan.points[6], n = plan.normals[6];
          ctx.arms.right.show(true);
          ctx.arms.left.show(true);
          ctx.arms.right.setTarget(mid.clone().addScaledVector(n, 3), n);
          ctx.arms.left.setTarget(mid.clone().addScaledVector(n, 2.5).add(new THREE.Vector3(0, 2.5, 0)), n);
          await ctx.flyTo(ctx.poseAt(mid, n, 16, 0.3), 1.6);
        },
      },
    },
    {
      id: 'bypass',
      title: 'Peripheral bypass and arrest',
      short: 'Femoral cannulation, endoaortic balloon, cardioplegia',
      instrument: 'Heart-lung machine',
      description: [
        'The heart-lung machine is connected through the femoral vessels in the groin. Once the circulation is supported, the ascending aorta is occluded with an endoaortic balloon and cardioplegia arrests the heart.',
        'A still, empty heart is essential: the atrium is about to be opened and the valve must be inspected without blood in the field.',
      ],
      action: {
        label: 'Start bypass and arrest the heart',
        doneLabel: 'Heart arrested',
        run: async (ctx) => {
          ctx.phys.startBypass();
          await wait(1200);
          await ctx.phys.arrest();
          await wait(500);
        },
      },
    },
    {
      id: 'atriotomy',
      title: 'Left atriotomy',
      short: '35 mm incision behind the interatrial groove',
      instrument: 'Monopolar scissors',
      description: [
        'The left atrium is entered through Sondergaard\'s groove, the fold between the two atria just in front of the right pulmonary veins. The incision runs parallel to the groove for about three and a half centimetres, from below the superior vena cava down towards the inferior vena cava.',
        'Straying forwards cuts into the right atrium; straying backwards injures the pulmonary veins. The line matters.',
      ],
      note: 'Tolerance 1.5 mm along a 35 mm line. Cut from the top marker to the bottom marker.',
      labels: ['la', 'ra', 'svc', 'ivc', 'pv'],
      pose: (ctx) => { const plan = atriotomyPlan(ctx); return ctx.poseAt(plan.points[6], plan.normals[6], 11, 0.25); },
      task: (ctx) => {
        const plan = atriotomyPlan(ctx);
        return new IncisionTask(ctx, heartSurface(ctx.heart), {
          title: 'Open the left atrium',
          instructions: 'Cut along the dashed line, parallel to the interatrial groove.',
          plan: plan.points,
          normals: plan.normals,
          toleranceCm: 0.15,
          tool: 'scissors',
          cutWidth: 0.14,
          cutDepth: 0.12,
          lift: 0.05,
        });
      },
    },
    {
      id: 'expose',
      title: 'Expose the valve',
      short: 'Atrial retractor, inspect leaflets and chords',
      instrument: 'Dynamic atrial retractor',
      description: [
        'A retractor blade lifts the atrial wall and the mitral valve comes into view from above, the surgeon\'s view. The anterior leaflet is the large leaflet nearest the aorta; the posterior leaflet has three scallops, P1, P2 and P3.',
        'A nerve hook is used to test each segment. Here P2 flails upward with a ruptured chord hanging from its edge, while the rest of the valve is competent.',
      ],
      scene: 'valve',
      action: {
        label: 'Place the retractor',
        doneLabel: 'Valve exposed',
        run: async (ctx) => {
          ctx.showScene('valve');
          await ctx.flyTo(surgeonView(ctx, 11), 1.8);
          const v = valveOf(ctx);
          ctx.arms.right.setTool('hook');
          ctx.arms.right.show(true);
          ctx.arms.left.show(false);
          ctx.arms.right.setTarget(w(ctx, v.p2Edge().add(new THREE.Vector3(0, 0.6, 0))), UP);
          ctx.hint('Flail P2 with a ruptured chord. The middle scallop of the posterior leaflet lifts above the annular plane.');
          await wait(1500);
        },
      },
    },
    {
      id: 'analysis',
      title: 'Valve analysis and sizing',
      short: 'Anterior leaflet height, intertrigonal distance',
      instrument: 'Calipers, ring sizer',
      description: [
        'Two measurements guide the repair. The height of the anterior leaflet, from its hinge to its free edge, tells you the size of ring that will fit. The distance between the two fibrous trigones checks that measurement against the annulus itself.',
        'Sizing matters: a ring that is too small pushes the anterior leaflet into the outflow tract; too large and the leaflets will not meet.',
      ],
      scene: 'valve',
      pose: (ctx) => surgeonView(ctx, 9.5),
      task: (ctx) => {
        const v = valveOf(ctx);
        const aml = v.amlHeightPoints();
        const tri = v.trigones;
        const pt = (p: THREE.Vector3, label: string): PointTarget => ({ position: w(ctx, p), normal: UP, label });
        return new MeasureTask(ctx, meshSurface(v.pickables), {
          title: 'Measure the valve',
          instructions: 'Measure the anterior leaflet height, then the intertrigonal distance.',
          pairs: [
            { name: 'Anterior leaflet height', a: pt(aml.hinge, 'Anterior hinge'), b: pt(aml.edge, 'Free edge'), expectedCm: aml.hinge.distanceTo(aml.edge) },
            { name: 'Intertrigonal distance', a: pt(tri.al, 'Anterolateral trigone'), b: pt(tri.pm, 'Posteromedial trigone'), expectedCm: tri.al.distanceTo(tri.pm) },
          ],
          toleranceCm: 0.1,
          onMeasured: (values) => { ctx.data.measurements = { ...values }; },
        });
      },
    },
    {
      id: 'resection',
      title: 'Triangular resection of P2',
      short: 'Remove the flail segment',
      instrument: 'Curved scissors',
      description: [
        'The flail portion of P2 is excised as a narrow triangle: the base along the free edge, the apex pointing towards the annulus but stopping short of it. Taking too much leaflet leaves nothing to close; leaving flail tissue behind leaves a leak.',
        'The cut runs down one side of the triangle, across the apex and back up the other side.',
      ],
      note: 'Tolerance 1 mm. Cut from the first free-edge marker, down to the apex, and back to the free edge.',
      scene: 'valve',
      pose: (ctx) => { const v = valveOf(ctx); const p = w(ctx, v.p2Edge()); return { position: p.clone().add(new THREE.Vector3(-1.8, 6.4, 3.4)), target: p.clone().add(new THREE.Vector3(0, -0.3, -0.4)), fov: 30 }; },
      task: (ctx) => {
        const v = valveOf(ctx);
        const local = v.resectionOutline();
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < local.length - 1; i++) for (let s = 0; s < 6; s++) pts.push(local[i].clone().lerp(local[i + 1], s / 6));
        pts.push(local[local.length - 1].clone());
        const plan = pts.map((p) => w(ctx, p.add(new THREE.Vector3(0, 0.01, 0))));
        return new IncisionTask(ctx, meshSurface([v.pml]), {
          title: 'Resect the flail segment',
          instructions: 'Trace the triangle: free edge, apex, free edge.',
          plan,
          normals: plan.map(() => UP.clone()),
          toleranceCm: 0.1,
          tool: 'scissors',
          cutWidth: 0.05,
          cutDepth: 0.04,
          lift: 0.03,
          onComplete: () => {
            v.state.resected = true;
            v.state.resectionClosed = 0;
            v.rebuild();
          },
        });
      },
    },
    {
      id: 'leaflet',
      title: 'Leaflet re-approximation',
      short: 'Close the resection with interrupted 5-0 sutures',
      instrument: 'Needle driver, 5-0 polypropylene',
      description: [
        'The two cut edges are brought together with fine interrupted stitches from the apex of the triangle out to the free edge. Each bite takes a millimetre of leaflet on either side.',
        'As the sutures are tied the posterior leaflet regains a smooth, continuous edge.',
      ],
      scene: 'valve',
      pose: (ctx) => { const v = valveOf(ctx); const p = w(ctx, v.p2Edge()); return { position: p.clone().add(new THREE.Vector3(-1.8, 6.4, 3.4)), target: p.clone().add(new THREE.Vector3(0, -0.3, -0.4)), fov: 30 }; },
      task: (ctx) => {
        const v = valveOf(ctx);
        const outline = v.resectionOutline();
        const n = 5;
        const targets: PointTarget[] = [];
        for (let i = 0; i < n; i++) {
          const t = 0.15 + 0.85 * (i / (n - 1));
          const left = outline[1].clone().lerp(outline[0], t);
          const right = outline[1].clone().lerp(outline[2], t);
          const mid = left.clone().lerp(right, 0.5).add(new THREE.Vector3(0, 0.02, 0));
          targets.push({ position: w(ctx, mid), normal: UP.clone(), label: i === 0 ? 'Apex' : i === n - 1 ? 'Free edge' : undefined });
        }
        return new PointsTask(ctx, meshSurface([v.pml, v.aml]), {
          title: 'Close the resection',
          instructions: 'Place 5 interrupted sutures from the apex to the free edge.',
          targets,
          toleranceCm: 0.08,
          thread: 'prolene',
          knots: false,
          markerRadius: 0.07,
          liftAmount: 0.06,
          startLabel: 'Start suturing',
          onPlace: (i) => {
            v.state.resectionClosed = (i + 1) / n;
            v.rebuild();
          },
        });
      },
    },
    {
      id: 'neochord',
      title: 'Neochordae',
      short: 'Two PTFE chords from the papillary heads to P2',
      instrument: 'Needle driver, 4-0 PTFE',
      description: [
        'The repaired P2 has lost its natural chords, so it is re-suspended with two artificial chords of expanded PTFE. Each is anchored in the head of a papillary muscle and passed through the free edge of the leaflet.',
        'Length is everything. Too long and the segment still prolapses; too short and it is tethered down, leaving a gap. The reference is the height at which the anterior leaflet\'s free edge meets the posterior leaflet.',
      ],
      note: 'Anchor each chord, then set the length to within a millimetre of the reference.',
      scene: 'valve',
      pose: (ctx) => surgeonView(ctx, 9.5),
      task: (ctx) => {
        const v = valveOf(ctx);
        const ideal = (v.idealNeochordLength(true) + v.idealNeochordLength(false)) / 2;
        const edgeL = v.group.localToWorld(v.p2Edge().add(new THREE.Vector3(-0.22, 0.02, 0)));
        const edgeR = v.group.localToWorld(v.p2Edge().add(new THREE.Vector3(0.22, 0.02, 0)));
        return new NeochordTask(ctx, meshSurface(v.pickables), {
          title: 'Implant neochordae',
          instructions: 'Anchor two chords from the papillary heads to the P2 free edge and set their length.',
          chords: [
            { tip: { position: w(ctx, v.alpmTip), normal: UP.clone(), label: 'Anterolateral papillary head' }, edge: { position: edgeL, normal: UP.clone(), label: 'P2 free edge' }, idealCm: ideal, label: 'Chord 1' },
            { tip: { position: w(ctx, v.pmpmTip), normal: UP.clone(), label: 'Posteromedial papillary head' }, edge: { position: edgeR, normal: UP.clone(), label: 'P2 free edge' }, idealCm: ideal, label: 'Chord 2' },
          ],
          toleranceCm: 0.1,
          apply: (err, pairs) => {
            v.state.neochordError = err;
            v.rebuild();
            v.setNeochords(pairs.map((p) => ({ from: v.group.worldToLocal(p.from.clone()), to: v.group.worldToLocal(p.to.clone()) })));
            v.refreshNeochords();
          },
        });
      },
    },
    {
      id: 'ring-size',
      title: 'Ring selection',
      short: 'Match the ring to the anterior leaflet',
      instrument: 'Ring sizers',
      description: [
        'Almost every repair is completed with an annuloplasty ring. It restores the shape of the dilated annulus, brings the posterior leaflet forwards to meet the anterior leaflet, and protects the repair from stretching again.',
        'The size is chosen with sizers that match the anterior leaflet height and the intertrigonal distance you measured earlier.',
      ],
      scene: 'valve',
      pose: (ctx) => surgeonView(ctx, 10),
      task: (ctx) => {
        const m = (ctx.data.measurements as Record<string, number> | undefined) ?? {};
        const aml = m['Anterior leaflet height'];
        const measured = aml ? `${(aml * 10).toFixed(0)} mm` : 'not measured';
        return new ChoiceTask(ctx, {
          title: 'Select the ring size',
          instructions: `Anterior leaflet height measured: ${measured}. Choose the ring whose sizer matches it.`,
          options: [
            { id: '26', title: '26 mm ring', desc: 'Small; sizer narrower than the leaflet', score: 55, feedback: 'Undersizing a degenerative valve with a tall anterior leaflet risks systolic anterior motion and outflow obstruction.' },
            { id: '28', title: '28 mm ring', desc: 'Sizer matches a 24 mm anterior leaflet', score: 100, feedback: 'Correct. The 28 mm sizer matches the anterior leaflet height of about 24 mm and the intertrigonal distance.' },
            { id: '30', title: '30 mm ring', desc: 'Slightly larger than the leaflet', score: 80, feedback: 'Acceptable and safe; a slightly larger ring still corrects the dilated annulus, with marginally less coaptation reserve.' },
            { id: '34', title: '34 mm ring', desc: 'Sizer much wider than the leaflet', score: 30, feedback: 'Too large. The annulus would not be reduced and the leaflets would fail to meet.' },
          ],
          onComplete: (_r, option) => {
            const size = parseInt(option.id, 10);
            valveOf(ctx).placeRing(size);
            ctx.data.ringSize = size;
          },
        });
      },
    },
    {
      id: 'ring',
      title: 'Ring implantation',
      short: '14 annular sutures, seat and tie',
      instrument: 'Needle driver, 2-0 braided sutures',
      description: [
        'Horizontal mattress sutures are placed around the whole annulus, evenly spaced, each taking a firm bite of fibrous tissue without catching the leaflets or the circumflex artery that runs just outside the posterior annulus.',
        'The sutures are passed through the ring, which is parachuted down onto the annulus and tied. The annulus takes on the ring\'s shape.',
      ],
      scene: 'valve',
      pose: (ctx) => surgeonView(ctx, 10.5),
      task: (ctx) => {
        const v = valveOf(ctx);
        const targets: PointTarget[] = v.ringSutureTargets(14).map((p, i) => ({ position: w(ctx, p), normal: UP.clone(), label: i === 0 ? 'Start' : undefined }));
        return new PointsTask(ctx, meshSurface([v.cuff, v.aml, v.pml]), {
          title: 'Place the annular sutures',
          instructions: 'Place 14 sutures around the annulus in order, then the ring is seated.',
          targets,
          toleranceCm: 0.1,
          thread: 'prolene',
          markerRadius: 0.08,
          liftAmount: 0.15,
          startLabel: 'Start suturing',
          onComplete: () => {
            const start = performance.now();
            const tick = () => {
              const f = Math.min(1, (performance.now() - start) / 1800);
              v.setRingSeated(f * f * (3 - 2 * f));
              v.refreshNeochords();
              if (f < 1) requestAnimationFrame(tick);
            };
            tick();
          },
        });
      },
    },
    {
      id: 'saline',
      title: 'Saline test',
      short: 'Fill the ventricle, check the coaptation line',
      instrument: 'Bulb syringe',
      description: [
        'Saline is injected into the ventricle through the valve until it fills and the leaflets close against the pressure. A competent repair shows a symmetric, curved line where the leaflets meet, with no leak.',
        'Any jet of saline back into the atrium marks a residual problem: a segment that still prolapses, a restricted leaflet or a gap at the suture line.',
      ],
      scene: 'valve',
      pose: (ctx) => surgeonView(ctx, 10),
      action: {
        label: 'Test the valve',
        doneLabel: 'Valve tested',
        run: async (ctx) => {
          const v = valveOf(ctx);
          ctx.arms.right.show(false);
          const start = performance.now();
          await new Promise<void>((resolve) => {
            const tick = () => {
              const f = Math.min(1, (performance.now() - start) / 2400);
              v.setClosure(MitralValve.REST_CLOSURE + (1 - MitralValve.REST_CLOSURE) * f);
              v.setSaline(-4.5 + 4.2 * f, true);
              if (f < 1) requestAnimationFrame(tick); else resolve();
            };
            tick();
          });
          const gap = v.regurgitation();
          const leak = gap > 0.12;
          v.setJet(leak);
          ctx.data.saline = { gap, leak };
          ctx.hint(leak
            ? `<b>Residual regurgitation.</b> A jet appears at P2 (gap ${(gap * 10).toFixed(1)} mm). In theatre this repair would be revised before closing.`
            : '<b>Competent valve.</b> Symmetric coaptation line, no leak. The repair is complete.');
          await wait(1500);
        },
      },
    },
    {
      id: 'close',
      title: 'Closure, de-airing and weaning',
      short: 'Atriotomy closed, heart restarted, report',
      instrument: 'Needle driver, 4-0 polypropylene',
      description: [
        'The retractor comes out and the atriotomy is closed with a running suture while the heart is de-aired. The aortic balloon is deflated, the heart is defibrillated and rewarmed, and bypass is weaned.',
        'A final echo confirms the repair with the heart beating. The case report summarises every measured step.',
      ],
      action: {
        label: 'Close and wean from bypass',
        doneLabel: 'Case complete',
        run: async (ctx) => {
          const v = valveOf(ctx);
          v.setJet(false);
          v.setSaline(-4.5, false);
          ctx.showScene('heart');
          const c = ctx.heart.heart.geometry.boundingSphere!.center;
          ctx.arms.right.show(false);
          ctx.arms.left.show(false);
          await ctx.flyTo({ position: c.clone().add(new THREE.Vector3(-20, 10, -20)), target: c.clone().add(new THREE.Vector3(0, 1.5, -2)), fov: 32 }, 1.6);
          await ctx.phys.reperfuse();
          await ctx.phys.wean();
        },
      },
    },
  ],
};
