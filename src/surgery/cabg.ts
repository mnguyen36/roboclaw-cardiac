/**
 * Coronary artery bypass grafting: robotic LIMA to LAD.
 * The precision-critical steps are the arteriotomy and the distal anastomosis.
 */
import * as THREE from 'three';
import type { ProcedureDef, SurgeryContext, TaskResult } from './types';
import { IncisionTask, PointsTask, ChoiceTask, vesselSurface, heartSurface, type PointTarget } from './tasks';
import { Graft, type AnastomosisSite } from '../scene/Graft';
import { icons } from '../ui/icons';
import { wait } from '../app/physiology';

const ARTERIOTOMY_LENGTH = 0.5; // cm
const SITE_T = 0.5;             // arc-length parameter on the LAD, distal to the stenosis

function siteFor(ctx: SurgeryContext): AnastomosisSite {
  const lad = ctx.heart.vessels.LAD;
  const c = lad.curve.getPointAt(SITE_T);
  const normal = ctx.heart.surfaceNormal(c);
  const tangent = lad.curve.getTangentAt(SITE_T);
  normal.addScaledVector(tangent, -normal.dot(tangent)).normalize();
  const point = c.clone().addScaledVector(normal, lad.radiusAt(SITE_T));
  return { point, normal, tangent, vesselT: SITE_T };
}

/** Points on top of the LAD along the planned arteriotomy. */
function arteriotomyPlan(ctx: SurgeryContext): { points: THREE.Vector3[]; normals: THREE.Vector3[]; t0: number; t1: number } {
  const lad = ctx.heart.vessels.LAD;
  const dt = ARTERIOTOMY_LENGTH / lad.length;
  const t0 = SITE_T - dt / 2, t1 = SITE_T + dt / 2;
  const points: THREE.Vector3[] = [], normals: THREE.Vector3[] = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const t = t0 + (t1 - t0) * (i / n);
    const c = lad.curve.getPointAt(t);
    const tangent = lad.curve.getTangentAt(t);
    const normal = ctx.heart.surfaceNormal(c);
    normal.addScaledVector(tangent, -normal.dot(tangent)).normalize();
    points.push(c.clone().addScaledVector(normal, lad.radiusAt(t)));
    normals.push(normal);
  }
  return { points, normals, t0, t1 };
}

/** Suture bites around the arteriotomy: heel, one side, toe, other side. */
function anastomosisTargets(ctx: SurgeryContext, t0: number, t1: number): PointTarget[] {
  const lad = ctx.heart.vessels.LAD;
  const bite = (t: number, angle: number): PointTarget => {
    const c = lad.curve.getPointAt(t);
    const tangent = lad.curve.getTangentAt(t);
    const up = ctx.heart.surfaceNormal(c);
    up.addScaledVector(tangent, -up.dot(tangent)).normalize();
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize();
    const dir = up.clone().multiplyScalar(Math.cos(angle)).addScaledVector(side, Math.sin(angle)).normalize();
    return { position: c.clone().addScaledVector(dir, lad.radiusAt(t)), normal: dir };
  };
  const dtEnd = 0.05 / lad.length;
  const per = 6;
  const targets: PointTarget[] = [];
  targets.push({ ...bite(t0 - dtEnd, 0), label: 'Heel' });
  for (let i = 0; i < per; i++) targets.push(bite(t0 + (t1 - t0) * ((i + 0.5) / per), 0.95));
  targets.push({ ...bite(t1 + dtEnd, 0), label: 'Toe' });
  for (let i = per - 1; i >= 0; i--) targets.push(bite(t0 + (t1 - t0) * ((i + 0.5) / per), -0.95));
  return targets;
}

export const cabgProcedure: ProcedureDef = {
  id: 'cabg',
  name: 'Coronary artery bypass',
  short: 'Robotic LIMA to LAD, single vessel',
  patient: '68-year-old, stable angina CCS III',
  indication: '72% proximal LAD stenosis after the first diagonal, unsuitable for stenting. Preserved ventricular function.',
  icon: icons.heart,
  steps: [
    {
      id: 'plan',
      title: 'Case review and conduit',
      short: 'Angiogram, target and graft choice',
      instrument: 'Planning console',
      description: [
        'The left anterior descending artery supplies the anterior wall and most of the septum. This patient has a 72% narrowing in its proximal third, just beyond the first diagonal branch, with a soft, disease-free segment further down.',
        'A bypass takes blood from an alternative artery around the blockage. The graft is joined end-to-side onto the LAD below the narrowing, so the target segment and the conduit both have to be chosen with care.',
      ],
      note: 'Look at the stenosis marker on the LAD, then decide which conduit to use.',
      labels: ['lad', 'stenosis', 'lv', 'rv', 'aorta', 'pa'],
      pose: (ctx) => ctx.poseAt(ctx.heart.vessels.LAD.curve.getPointAt(0.4), ctx.heart.surfaceNormal(ctx.heart.vessels.LAD.curve.getPointAt(0.4)), 26, 0.25),
      task: (ctx) => new ChoiceTask(ctx, {
        title: 'Choose the conduit for the LAD',
        instructions: 'Pick the graft with the best long-term patency for this target.',
        options: [
          { id: 'lima', title: 'Left internal mammary artery (LIMA)', desc: 'Pedicled arterial graft from the chest wall, harvested endoscopically', score: 100, feedback: 'The LIMA to LAD graft has over 90% patency at 10 years and is the standard of care for this target.' },
          { id: 'svg', title: 'Saphenous vein graft', desc: 'Free vein graft from the leg, needs a proximal aortic anastomosis', score: 55, feedback: 'Vein grafts work, but roughly half occlude within ten years. For the LAD an arterial conduit is preferred.' },
          { id: 'radial', title: 'Radial artery', desc: 'Free arterial graft, spasm-prone, needs an aortic anastomosis', score: 70, feedback: 'A reasonable arterial conduit, usually reserved for the second or third target. The LIMA remains the first choice for the LAD.' },
          { id: 'rima', title: 'Right internal mammary artery', desc: 'Second mammary artery, often used for the circumflex territory', score: 78, feedback: 'Excellent conduit, but conventionally the LIMA goes to the LAD and the RIMA to another target.' },
        ],
      }),
    },
    {
      id: 'access',
      title: 'Port placement and docking',
      short: 'Three left-chest ports, endoscope in the 5th space',
      instrument: 'Robotic ports, 8 mm',
      description: [
        'Instead of opening the breastbone, three small ports are placed between the ribs on the left side: an endoscope in the fifth intercostal space and two instrument arms above and below it. The left lung is deflated to make room.',
        'The robotic arms are docked to the ports. From here on the surgeon works from a console with a magnified three-dimensional view.',
      ],
      pose: (ctx) => ctx.poseAt(ctx.heart.vessels.LAD.curve.getPointAt(0.45), ctx.heart.surfaceNormal(ctx.heart.vessels.LAD.curve.getPointAt(0.45)), 18, 0.35),
      action: {
        label: 'Dock the robot',
        doneLabel: 'Robot docked',
        run: async (ctx) => {
          ctx.arms.right.show(true);
          ctx.arms.left.show(true);
          const site = siteFor(ctx);
          ctx.arms.right.setTarget(site.point.clone().addScaledVector(site.normal, 2.5), site.normal);
          ctx.arms.left.setTarget(site.point.clone().addScaledVector(site.normal, 2.2).addScaledVector(site.tangent, -2.5), site.normal);
          await ctx.flyTo(ctx.poseAt(site.point, site.normal, 12, 0.3), 1.6);
        },
      },
    },
    {
      id: 'lima',
      title: 'Harvest the LIMA',
      short: 'Skeletonised pedicle from the chest wall',
      instrument: 'Bipolar forceps, spatula',
      description: [
        'The left internal mammary artery runs down the inside of the chest wall about a centimetre from the edge of the breastbone. It is freed along its length with the harmonic scalpel and bipolar forceps, keeping its accompanying veins and a thin layer of tissue as a pedicle.',
        'After heparin is given, the artery is divided at its lower end and the distal tip is trimmed and spatulated, ready to be sewn onto the LAD.',
      ],
      note: 'A good LIMA has pulsatile free flow of more than 60 mL/min before it is used.',
      action: {
        label: 'Harvest and prepare the LIMA',
        doneLabel: 'LIMA prepared',
        run: async (ctx) => {
          const site = siteFor(ctx);
          if (!ctx.graft) {
            ctx.graft = new Graft(ctx.heart, site);
            ctx.sm.scene.add(ctx.graft.group);
            ctx.graft.setHover(1, true);
          }
          ctx.data.site = site;
          ctx.arms.left.setTarget(ctx.graft.distalEnd.clone().addScaledVector(site.normal, 0.3), site.normal);
          await ctx.flyTo(ctx.poseAt(site.point, site.normal, 14, 0.4), 1.4);
        },
      },
    },
    {
      id: 'target',
      title: 'Identify the anastomosis site',
      short: 'Soft segment 15 mm beyond the stenosis',
      instrument: 'Endoscope, 30° optic',
      description: [
        'The anastomosis has to sit on a straight, disease-free part of the artery, far enough beyond the narrowing that the graft supplies everything downstream, but proximal enough to feed the diagonal branches when possible.',
        'The vessel is followed distally from the plaque with the endoscope until the wall looks soft and compliant, then the site is marked.',
      ],
      note: 'The planned site is about 15 mm distal to the stenosis on the mid LAD, where the artery is around 2 mm across.',
      labels: ['lad', 'stenosis'],
      pose: (ctx) => { const s = siteFor(ctx); return ctx.poseAt(s.point, s.normal, 9, 0.35); },
      task: (ctx) => {
        const site = siteFor(ctx);
        return new PointsTask(ctx, vesselSurface(ctx.heart.vessels.LAD, ctx.heart), {
          title: 'Mark the anastomosis site',
          instructions: 'Click the centre of the planned site on the LAD.',
          targets: [{ position: site.point, normal: site.normal, label: 'Anastomosis site' }],
          toleranceCm: 0.15,
          thread: 'none',
          single: true,
          markerRadius: 0.16,
          startLabel: 'Mark the site',
        });
      },
    },
    {
      id: 'bypass',
      title: 'Bypass and cardioplegic arrest',
      short: 'Femoral cannulation, endoaortic balloon, cold cardioplegia',
      instrument: 'Heart-lung machine',
      description: [
        'For a still, bloodless field the heart is stopped. The femoral vessels are cannulated and the heart-lung machine takes over the circulation. An endoaortic balloon occludes the ascending aorta and cold potassium cardioplegia is delivered into the coronary arteries.',
        'The heart fibrillates briefly, then arrests in diastole. The cross-clamp clock starts now: every minute of arrest counts.',
      ],
      note: 'Some surgeons do this anastomosis on the beating heart with a stabiliser. Arrest gives a motionless target, which is why it is used here for maximum precision.',
      action: {
        label: 'Start bypass and arrest the heart',
        doneLabel: 'Heart arrested',
        run: async (ctx) => {
          ctx.phys.startBypass();
          await wait(1200);
          await ctx.phys.arrest();
          await wait(600);
        },
      },
    },
    {
      id: 'arteriotomy',
      title: 'Arteriotomy',
      short: '5 mm longitudinal incision on the LAD',
      instrument: 'Beaver blade in the needle driver',
      description: [
        'The artery wall is opened along its long axis with a fine blade, exactly on the midline of the vessel and no longer than the spatulated graft tip. The cut must go through the wall into the lumen in one clean stroke without touching the back wall.',
        'Deviating sideways narrows the anastomosis and can tear the wall; a cut that is too long leaves a gap the graft cannot cover.',
      ],
      note: 'Tolerance here is a third of a millimetre. On a 2 mm vessel there is no room for tremor.',
      pose: (ctx) => { const s = siteFor(ctx); return ctx.poseAt(s.point, s.normal, 7.5, 0.32); },
      task: (ctx) => {
        const plan = arteriotomyPlan(ctx);
        ctx.data.arteriotomy = plan;
        return new IncisionTask(ctx, vesselSurface(ctx.heart.vessels.LAD, ctx.heart), {
          title: 'Open the LAD',
          instructions: 'Cut 5 mm along the vessel midline, from heel to toe.',
          plan: plan.points,
          normals: plan.normals,
          toleranceCm: 0.03,
          depthMm: 0.5,
          // on a 2 mm vessel the arteriotomy gapes open to show the lumen beneath
          cutWidth: 0.05,
          cutDepth: 0.055,
          lift: 0.05,
        });
      },
    },
    {
      id: 'anastomosis',
      title: 'Distal anastomosis',
      short: 'Running 7-0 polypropylene, 14 bites',
      instrument: 'Needle drivers, 7-0 polypropylene',
      description: [
        'The graft is sewn to the arteriotomy with a single running stitch. Starting at the heel, bites are taken through the graft and the artery wall about a millimetre from the edge, evenly spaced, around one side to the toe and back along the other side.',
        'Even spacing and a consistent distance from the edge are what keep the join watertight without narrowing it. The graft is then parachuted down onto the artery and the suture is tied.',
      ],
      note: 'Bites are placed in order: heel, one side, toe, the other side. Each ring is one bite.',
      pose: (ctx) => { const s = siteFor(ctx); return ctx.poseAt(s.point, s.normal, 5.5, 0.3); },
      task: (ctx) => {
        const plan = (ctx.data.arteriotomy as ReturnType<typeof arteriotomyPlan>) ?? arteriotomyPlan(ctx);
        const targets = anastomosisTargets(ctx, plan.t0, plan.t1);
        return new PointsTask(ctx, vesselSurface(ctx.heart.vessels.LAD, ctx.heart), {
          title: 'Sew the graft to the LAD',
          instructions: 'Place 14 bites around the arteriotomy in the order shown.',
          targets,
          toleranceCm: 0.04,
          thread: 'prolene',
          markerRadius: 0.05,
          liftAmount: 0.1,
          startLabel: 'Start suturing',
          onComplete: () => {
            ctx.graft?.setHover(0);
            setTimeout(() => ctx.graft?.attachToHeart(), 2500);
          },
        });
      },
    },
    {
      id: 'flow',
      title: 'Graft flow assessment',
      short: 'Transit-time flow measurement',
      instrument: 'Transit-time flow probe',
      description: [
        'Before the chest is closed the graft is checked with an ultrasonic transit-time probe. A good LIMA to LAD graft shows a mean flow above 20 mL/min, a pulsatility index below 3 and mostly diastolic flow.',
        'A technical problem at the anastomosis shows up here as low flow with a high pulsatility index and would be revised immediately.',
      ],
      pose: (ctx) => { const s = siteFor(ctx); return ctx.poseAt(s.point, s.normal, 9, 0.35); },
      action: {
        label: 'Measure graft flow',
        doneLabel: 'Flow measured',
        run: async (ctx) => {
          const r = ctx.results.anastomosis as TaskResult | undefined;
          const quality = r ? r.score / 100 : 0.9;
          const mean = Math.round(18 + 28 * quality);
          const pi = (4.2 - 2.4 * quality).toFixed(1);
          const df = Math.round(52 + 22 * quality);
          ctx.graft?.setFlow(true);
          ctx.data.flow = { mean, pi, df };
          ctx.hint(`Transit-time flow: <b>${mean} mL/min</b>, pulsatility index <b>${pi}</b>, diastolic filling <b>${df}%</b>.`);
          await wait(2500);
        },
      },
    },
    {
      id: 'wean',
      title: 'Reperfusion and weaning',
      short: 'Clamp off, rewarm, defibrillate, come off bypass',
      instrument: 'Heart-lung machine',
      description: [
        'The aortic balloon is deflated, warm blood flows back into the coronary arteries and the heart is rewarmed. It usually fibrillates first and is shocked back into sinus rhythm.',
        'Once the heart is contracting well the pump flow is turned down step by step and the heart takes over the circulation again. The new graft now carries pulsatile flow into the LAD.',
      ],
      action: {
        label: 'Release the clamp and wean from bypass',
        doneLabel: 'Off bypass',
        run: async (ctx) => {
          await ctx.phys.reperfuse();
          await ctx.phys.wean();
          if (ctx.graft) ctx.graft.flowSpeed = 1.4;
        },
      },
      pose: (ctx) => ctx.poseAt(ctx.heart.vessels.LAD.curve.getPointAt(0.45), ctx.heart.surfaceNormal(ctx.heart.vessels.LAD.curve.getPointAt(0.45)), 24, 0.3),
    },
    {
      id: 'close',
      title: 'Closure and report',
      short: 'Drains, port closure, precision summary',
      instrument: 'Console',
      description: [
        'Protamine reverses the heparin, a drain is placed, the lung is re-expanded and the three port sites are closed. The patient goes to intensive care and is typically walking the next day.',
        'The case report below summarises every measured step, the control mode that was used and how far each cut and stitch was from the plan.',
      ],
      action: {
        label: 'Complete the case',
        doneLabel: 'Case complete',
        run: async (ctx) => { ctx.arms.right.show(false); ctx.arms.left.show(false); await wait(300); },
      },
      pose: (ctx) => ctx.poseAt(ctx.heart.vessels.LAD.curve.getPointAt(0.4), ctx.heart.surfaceNormal(ctx.heart.vessels.LAD.curve.getPointAt(0.4)), 30, 0.25),
    },
  ],
};

export { heartSurface };
