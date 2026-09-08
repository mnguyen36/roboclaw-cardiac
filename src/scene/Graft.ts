/**
 * Left internal mammary artery (LIMA) graft with a spatulated distal end, plus flow particles
 * that run through the graft into the distal LAD once the anastomosis is complete.
 */
import * as THREE from 'three';
import { buildTubeGeometry } from './tubes';
import type { HeartModel } from './HeartBuilder';
import { applyBeatShader } from './heartbeat';

export interface AnastomosisSite {
  point: THREE.Vector3;    // on the vessel surface, centre of the arteriotomy
  normal: THREE.Vector3;   // outward
  tangent: THREE.Vector3;  // distal flow direction along the LAD
  vesselT: number;         // arc-length parameter on the LAD curve
}

export class Graft {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh;
  private material: THREE.MeshPhysicalMaterial;
  private hover = 1;
  private targetHover = 1;
  private flowMesh: THREE.InstancedMesh;
  private flowParams: Float32Array;
  private flowOn = false;
  private flowCurve: THREE.CurvePath<THREE.Vector3> | null = null;
  private origin: THREE.Vector3;
  private dummy = new THREE.Object3D();
  flowSpeed = 1;

  constructor(private heart: HeartModel, private site: AnastomosisSite) {
    this.group.name = 'graft';
    this.origin = new THREE.Vector3(7.5, 14, 6.5);
    this.material = new THREE.MeshPhysicalMaterial({
      color: 0xb8666c, roughness: 0.42, clearcoat: 0.9, clearcoatRoughness: 0.2, sheen: 0.3, sheenColor: new THREE.Color(0xffb0b0),
    });
    this.mesh = new THREE.Mesh(this.buildGeometry(1), this.material);
    this.mesh.castShadow = true;
    this.mesh.name = 'graft-lima';
    this.group.add(this.mesh);
    const particleGeo = new THREE.SphereGeometry(0.05, 6, 5);
    const particleMat = new THREE.MeshBasicMaterial({ color: 0xff3b3b });
    this.flowMesh = new THREE.InstancedMesh(particleGeo, particleMat, 160);
    this.flowMesh.visible = false;
    this.flowMesh.frustumCulled = false;
    this.flowParams = new Float32Array(160);
    for (let i = 0; i < 160; i++) this.flowParams[i] = Math.random();
    this.group.add(this.flowMesh);
  }

  private curveFor(hover: number): THREE.CatmullRomCurve3 {
    const { point, normal, tangent } = this.site;
    const side = new THREE.Vector3().crossVectors(normal, tangent).normalize();
    // while waiting, the graft is held beside the artery, never between the endoscope and the target
    const lift = normal.clone().multiplyScalar(0.55 * hover).addScaledVector(side, 1.5 * hover);
    // the pedicle comes from the left chest wall and runs down the LAD from its proximal side,
    // staying close to the epicardium so it never crosses the endoscope's line of sight
    const pts = [
      this.origin.clone(),
      point.clone().addScaledVector(tangent, -8).addScaledVector(normal, 2.6).addScaledVector(side, 1.2),
      point.clone().addScaledVector(tangent, -4.2).addScaledVector(normal, 1.4).addScaledVector(side, 0.6).add(lift),
      point.clone().addScaledVector(tangent, -1.6).addScaledVector(normal, 0.6).addScaledVector(side, 0.15).add(lift),
      point.clone().addScaledVector(tangent, -0.4).addScaledVector(normal, 0.22).add(lift),
      point.clone().addScaledVector(tangent, 0.35).addScaledVector(normal, 0.1).add(lift),
    ];
    return new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
  }

  private buildGeometry(hover: number): THREE.BufferGeometry {
    const curve = this.curveFor(hover);
    const geo = buildTubeGeometry({
      curve, segments: 120, radial: 16, caps: true,
      radius: (t) => {
        const base = 0.14;
        // spatulated hood: widens over the last 6% then closes
        const hood = t > 0.93 ? 1 + 0.5 * Math.sin(((t - 0.93) / 0.07) * Math.PI) : 1;
        return base * hood;
      },
    });
    return geo;
  }

  /** 1 = held above the artery, 0 = seated on the arteriotomy. */
  setHover(h: number, immediate = false): void {
    this.targetHover = h;
    if (immediate) { this.hover = h; this.rebuild(); }
  }

  private rebuild(): void {
    this.mesh.geometry.dispose();
    this.mesh.geometry = this.buildGeometry(this.hover);
  }

  /** Once seated, the graft should move with the heart. */
  attachToHeart(): void {
    const pos = this.mesh.geometry.getAttribute('position');
    const w = new Float32Array(pos.count);
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      // only the distal part follows the heart; the pedicle stays fixed to the chest wall
      const d = p.distanceTo(this.site.point);
      w[i] = this.heart.beatWeightAt(p) * THREE.MathUtils.smoothstep(6 - d, 0, 4);
    }
    this.mesh.geometry.setAttribute('aBeatWeight', new THREE.Float32BufferAttribute(w, 1));
    applyBeatShader(this.material, this.heart.beat);
  }

  setFlow(on: boolean): void {
    this.flowOn = on;
    this.flowMesh.visible = on;
    if (on && !this.flowCurve) {
      const lad = this.heart.vessels.LAD;
      const path = new THREE.CurvePath<THREE.Vector3>();
      path.add(this.curveFor(0));
      const distal: THREE.Vector3[] = [];
      for (let i = 0; i <= 24; i++) {
        const t = this.site.vesselT + (1 - this.site.vesselT) * (i / 24);
        distal.push(lad.curve.getPointAt(Math.min(1, t)));
      }
      path.add(new THREE.CatmullRomCurve3(distal));
      this.flowCurve = path;
    }
  }

  update(dt: number, contraction: number): void {
    if (Math.abs(this.hover - this.targetHover) > 1e-3) {
      this.hover += (this.targetHover - this.hover) * Math.min(1, dt * 2.2);
      if (Math.abs(this.hover - this.targetHover) < 1e-3) this.hover = this.targetHover;
      this.rebuild();
    }
    if (this.flowOn && this.flowCurve) {
      const speed = (0.06 + 0.16 * contraction) * this.flowSpeed;
      const lengths = this.flowCurve.getCurveLengths();
      const total = lengths[lengths.length - 1];
      for (let i = 0; i < this.flowParams.length; i++) {
        this.flowParams[i] = (this.flowParams[i] + (speed * dt) / (total / 30)) % 1;
        const p = this.flowCurve.getPointAt(this.flowParams[i]);
        this.dummy.position.copy(p);
        const s = 0.7 + 0.5 * Math.sin(i * 1.7);
        this.dummy.scale.setScalar(s);
        this.dummy.updateMatrix();
        this.flowMesh.setMatrixAt(i, this.dummy.matrix);
      }
      this.flowMesh.instanceMatrix.needsUpdate = true;
    }
  }

  get distalEnd(): THREE.Vector3 { return this.curveFor(this.hover).getPointAt(1); }
  get meshObject(): THREE.Mesh { return this.mesh; }
}
