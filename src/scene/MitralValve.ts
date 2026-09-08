/**
 * Parametric mitral valve as seen through a left atriotomy: saddle-shaped annulus,
 * anterior leaflet, three-scalloped posterior leaflet with a flail P2 segment,
 * chordae tendineae, papillary muscles, and the surrounding atrial and ventricular walls.
 *
 * Local frame (centimetres): origin at the annulus centre, +y towards the left atrium,
 * +x towards the anterolateral commissure, +z posterior.
 */
import * as THREE from 'three';
import { noise } from './noise';
import { Overlays } from './overlays';

export interface ValveState {
  /** 0 = normal, 1 = flail P2 with ruptured chord. */
  prolapse: number;
  /** Triangular resection of P2 present. */
  resected: boolean;
  /** 0 = gap open, 1 = resection edges sutured together. */
  resectionClosed: number;
  /** Signed error of neochord length in cm (+ = too long -> residual prolapse). */
  neochordError: number | null;
  ringSize: number | null;
  /** 0 = ring hovering above, 1 = seated and annulus remodelled. */
  ringSeated: number;
  /** 0 = flaccid arrested leaflets, 1 = pressurised (saline test / systole). */
  closure: number;
}

const AML_SPAN = 1.3;                     // half angular span of the anterior leaflet
const RX = 1.65, RZ = 1.35;               // annulus radii (cm)
const SADDLE = 0.26;

const leafletMat = new THREE.MeshPhysicalMaterial({
  color: 0xe6c8c2, roughness: 0.42, clearcoat: 0.7, clearcoatRoughness: 0.3, side: THREE.DoubleSide,
  sheen: 0.4, sheenColor: new THREE.Color(0xffd6d0), sheenRoughness: 0.8, transparent: true, opacity: 0.98,
});
const chordMat = new THREE.MeshStandardMaterial({ color: 0xf1e9e0, roughness: 0.55 });
const muscleMat = new THREE.MeshPhysicalMaterial({ color: 0x8c3038, roughness: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.3 });
const cavityMat = new THREE.MeshPhysicalMaterial({ color: 0x6a232a, roughness: 0.55, clearcoat: 0.6, clearcoatRoughness: 0.35, side: THREE.BackSide });
const atriumMat = new THREE.MeshPhysicalMaterial({ color: 0xa8525f, roughness: 0.48, clearcoat: 0.8, clearcoatRoughness: 0.28, side: THREE.DoubleSide });
const ringMat = new THREE.MeshStandardMaterial({ color: 0xf1ecdc, roughness: 0.85 });
const ringDotMat = new THREE.MeshStandardMaterial({ color: 0x2f8f5b, roughness: 0.6 });
const salineMat = new THREE.MeshPhysicalMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.35, roughness: 0.1, transmission: 0, side: THREE.DoubleSide, depthWrite: false });
const retractorMat = new THREE.MeshStandardMaterial({ color: 0xc9cdd2, metalness: 1, roughness: 0.3 });

export class MitralValve {
  readonly group = new THREE.Group();
  /** Leaflet posture of the arrested, flaccid valve as seen by the surgeon. */
  static readonly REST_CLOSURE = 0.55;
  state: ValveState = { prolapse: 1, resected: false, resectionClosed: 0, neochordError: null, ringSize: null, ringSeated: 0, closure: MitralValve.REST_CLOSURE };
  readonly aml: THREE.Mesh;
  readonly pml: THREE.Mesh;
  readonly papillaryAL: THREE.Mesh;
  readonly papillaryPM: THREE.Mesh;
  readonly cuff: THREE.Mesh;
  readonly cavity: THREE.Mesh;
  private chordGroup = new THREE.Group();
  private stump: THREE.Mesh | null = null;
  private ring: THREE.Group | null = null;
  private neochordMeshes: THREE.Mesh[] = [];
  private saline: THREE.Mesh;
  private salineLevel = -4.5;
  private jet: THREE.InstancedMesh;
  private jetParams: Float32Array;
  private dummy = new THREE.Object3D();
  private time = 0;
  readonly alpmTip = new THREE.Vector3(1.0, -2.1, 0.15);
  readonly pmpmTip = new THREE.Vector3(-1.0, -2.1, 0.4);
  private resectionSeam: THREE.Group | null = null;

  constructor() {
    this.group.name = 'mitral-valve';
    this.aml = new THREE.Mesh(new THREE.BufferGeometry(), leafletMat);
    this.pml = new THREE.Mesh(new THREE.BufferGeometry(), leafletMat);
    this.aml.name = 'leaflet-anterior';
    this.pml.name = 'leaflet-posterior';
    this.aml.castShadow = this.pml.castShadow = true;
    this.aml.receiveShadow = this.pml.receiveShadow = true;
    this.group.add(this.aml, this.pml, this.chordGroup);

    // Papillary muscles
    const pm = (tip: THREE.Vector3, tilt: number) => {
      const geo = new THREE.CylinderGeometry(0.16, 0.62, 2.6, 18, 6, false);
      const pos = geo.getAttribute('position');
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const n = noise.fbm(v.x * 3 + tip.x, v.y * 2, v.z * 3 + tip.z, 2);
        const r = Math.hypot(v.x, v.z);
        if (r > 0.01) { v.x += (v.x / r) * n * 0.12; v.z += (v.z / r) * n * 0.12; }
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, muscleMat);
      m.position.copy(tip).add(new THREE.Vector3(0, -1.3, 0));
      m.rotation.z = tilt;
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    };
    this.papillaryAL = pm(this.alpmTip, -0.18);
    this.papillaryPM = pm(this.pmpmTip, 0.18);
    this.papillaryAL.name = 'papillary-anterolateral';
    this.papillaryPM.name = 'papillary-posteromedial';
    const head = (tip: THREE.Vector3) => { const s = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), muscleMat); s.position.copy(tip); return s; };
    this.group.add(this.papillaryAL, this.papillaryPM, head(this.alpmTip), head(this.pmpmTip));

    // Left ventricular cavity (inside of an ellipsoid, clipped at the annular plane)
    const cav = new THREE.SphereGeometry(1, 64, 48);
    cav.scale(2.9, 4.6, 2.7);
    cav.translate(0, -3.2, 0.1);
    const cp = cav.getAttribute('position');
    const cv = new THREE.Vector3();
    for (let i = 0; i < cp.count; i++) {
      cv.fromBufferAttribute(cp, i);
      const n = noise.fbm(cv.x * 2.4, cv.y * 2.4, cv.z * 2.4, 3) * 0.14 + noise.ridged(cv.x * 5, cv.y * 5, cv.z * 5, 2) * 0.1;
      const dir = cv.clone().sub(new THREE.Vector3(0, -3.2, 0.1)).normalize();
      cv.addScaledVector(dir, -n * Math.min(1, Math.max(0, (-cv.y - 0.3) / 1.5)));
      cp.setXYZ(i, cv.x, cv.y, cv.z);
    }
    cav.computeVertexNormals();
    this.cavity = new THREE.Mesh(cav, cavityMat);
    cavityMat.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 0.05)];
    this.cavity.receiveShadow = true;
    this.group.add(this.cavity);

    // Atrial cuff: retracted atrial wall rising away from the annulus
    this.cuff = new THREE.Mesh(this.buildCuff(), atriumMat);
    this.cuff.receiveShadow = true;
    this.group.add(this.cuff);
    // Retractor blades
    for (const a of [0.9, 2.2, 4.1]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.4, 0.08), retractorMat);
      const p = this.annulus(a);
      blade.position.set(p.x * 1.72, 1.1, p.z * 1.72);
      blade.lookAt(0, 0.9, 0);
      this.group.add(blade);
    }

    // Saline and regurgitant jet
    this.saline = new THREE.Mesh(new THREE.CircleGeometry(2.6, 48), salineMat);
    this.saline.rotation.x = -Math.PI / 2;
    this.saline.position.y = this.salineLevel;
    this.saline.visible = false;
    this.group.add(this.saline);
    this.jet = new THREE.InstancedMesh(new THREE.SphereGeometry(0.035, 6, 5), new THREE.MeshBasicMaterial({ color: 0xd7f1ff, transparent: true, opacity: 0.85 }), 220);
    this.jet.visible = false;
    this.jet.frustumCulled = false;
    this.jetParams = new Float32Array(220 * 4);
    for (let i = 0; i < 220; i++) {
      this.jetParams[i * 4] = Math.random();
      this.jetParams[i * 4 + 1] = (Math.random() - 0.5) * 0.25;
      this.jetParams[i * 4 + 2] = (Math.random() - 0.5) * 0.25;
      this.jetParams[i * 4 + 3] = 0.6 + Math.random() * 0.8;
    }
    this.group.add(this.jet);

    this.rebuild();
  }

  // ---------------------------------------------------------------- annulus
  private annulusScale(): { sx: number; sz: number } {
    if (this.state.ringSize == null) return { sx: 1, sz: 1 };
    const target = this.state.ringSize / 33; // 33 mm is the native intercommissural width
    const s = this.state.ringSeated;
    return { sx: 1 + (Math.min(1, target * 1.02) - 1) * s, sz: 1 + (Math.min(1, target * 0.94) - 1) * s };
  }

  /** Annulus point at angle phi (0 = anterior midpoint, pi = posterior midpoint). */
  annulus(phi: number, scaled = true): THREE.Vector3 {
    const c = Math.cos(phi);
    const flat = 1 - 0.22 * Math.max(0, c) * Math.max(0, c);
    const { sx, sz } = scaled ? this.annulusScale() : { sx: 1, sz: 1 };
    return new THREE.Vector3(RX * Math.sin(phi) * sx, SADDLE * Math.cos(2 * phi), -RZ * c * flat * sz);
  }

  /** Coaptation line point for s in [-1, 1] (from posteromedial to anterolateral commissure). */
  private coaptation(s: number): THREE.Vector3 {
    const comm = this.annulus(s >= 0 ? AML_SPAN : -AML_SPAN);
    const c0 = new THREE.Vector3(0, -0.55, 0.34);
    const w = s * s;
    return c0.clone().multiplyScalar(1 - w).add(comm.multiplyScalar(w)).add(new THREE.Vector3(0, -0.15 * (1 - w), 0));
  }

  // ---------------------------------------------------------------- leaflets
  private leafletPoint(phi: number, v: number, isAnterior: boolean, q: number): THREE.Vector3 {
    const st = this.state;
    const P0 = this.annulus(phi);
    const inward = new THREE.Vector3(-P0.x, 0, -P0.z).normalize();
    let H: number;
    let s: number;
    if (isAnterior) {
      H = 1.1 + 1.3 * Math.cos((phi / AML_SPAN) * Math.PI * 0.5);
      s = phi / AML_SPAN;
    } else {
      const scallop = (a: number, b: number) => (q >= a && q <= b ? Math.sin(((q - a) / (b - a)) * Math.PI) : 0);
      H = 0.95 + 0.42 * (scallop(0, 0.3) + 1.12 * scallop(0.3, 0.7) + scallop(0.7, 1));
      s = 1 - 2 * q;
    }
    const open = P0.clone().addScaledVector(inward, 0.42 * H).add(new THREE.Vector3(0, -0.88 * H, 0));
    const closed = this.coaptation(s).add(isAnterior ? new THREE.Vector3(0, -0.22, 0.16) : new THREE.Vector3(0, -0.04, -0.06));
    const c = st.closure;
    const P2 = open.lerp(closed, c);
    // pathology / repair offsets applied to the P2 segment
    if (!isAnterior) {
      const bumpP2 = Math.max(0, 1 - Math.abs((q - 0.5) / 0.2));
      const shaped = bumpP2 * bumpP2 * (3 - 2 * bumpP2);
      let lift = 0;
      if (!st.resected) lift = st.prolapse * (0.55 + 0.5 * c) * shaped;
      else if (st.neochordError != null) lift = st.neochordError * (0.4 + 0.6 * c) * shaped;
      P2.y += lift;
      if (lift < 0) P2.addScaledVector(inward, lift * 0.3);
    }
    const billow = (0.12 * c + 0.04) * H;
    const P1 = P0.clone().add(P2).multiplyScalar(0.5).add(new THREE.Vector3(0, billow, 0)).addScaledVector(inward, 0.12 * H);
    const a = (1 - v) * (1 - v), b = 2 * (1 - v) * v, d = v * v;
    return new THREE.Vector3(
      P0.x * a + P1.x * b + P2.x * d,
      P0.y * a + P1.y * b + P2.y * d,
      P0.z * a + P1.z * b + P2.z * d,
    );
  }

  private resectionHalfWidth(v: number): number {
    return 0.085 * THREE.MathUtils.smoothstep(v, 0.22, 1);
  }

  private buildLeaflet(isAnterior: boolean): THREE.BufferGeometry {
    const nu = isAnterior ? 56 : 96, nv = 22;
    const phi0 = isAnterior ? -AML_SPAN : AML_SPAN;
    const phi1 = isAnterior ? AML_SPAN : Math.PI * 2 - AML_SPAN;
    const positions: number[] = [];
    const uvs: number[] = [];
    const inside = new Uint8Array((nu + 1) * (nv + 1));
    const st = this.state;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      let q = u;
      for (let j = 0; j <= nv; j++) {
        const v = j / nv;
        let qe = q;
        if (!isAnterior && st.resected) {
          const w = this.resectionHalfWidth(v);
          const d = q - 0.5;
          if (Math.abs(d) < w) inside[i * (nv + 1) + j] = 1;
          qe = q - Math.sign(d) * w * st.resectionClosed;
          if (Math.abs(d) < w) qe = 0.5;
        }
        const phi = phi0 + (phi1 - phi0) * qe;
        const p = this.leafletPoint(phi, v, isAnterior, qe);
        positions.push(p.x, p.y, p.z);
        uvs.push(u, v);
      }
    }
    const indices: number[] = [];
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const a = i * (nv + 1) + j, b = a + nv + 1, c = b + 1, d = a + 1;
        if (!isAnterior && st.resected && st.resectionClosed < 0.999) {
          if (inside[a] || inside[b] || inside[c] || inside[d]) continue;
        }
        indices.push(a, b, d, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    g.computeVertexNormals();
    return g;
  }

  private buildCuff(): THREE.BufferGeometry {
    const n = 96, m = 12;
    const positions: number[] = [];
    for (let i = 0; i <= n; i++) {
      const phi = (i / n) * Math.PI * 2;
      const a = this.annulus(phi, false);
      for (let j = 0; j <= m; j++) {
        const w = j / m;
        const r = 1 + w * 0.8;
        const noiseR = 1 + noise.fbm(Math.cos(phi) * 3, w * 4, Math.sin(phi) * 3, 2) * 0.04;
        positions.push(a.x * r * noiseR, a.y * (1 - w) + w * w * 1.15 + w * 0.05, a.z * r * noiseR);
      }
    }
    const indices: number[] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
      const a = i * (m + 1) + j, b = a + m + 1, c = b + 1, d = a + 1;
      indices.push(a, d, b, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    return g;
  }

  /** Regenerate leaflets, chordae and seam from the current state. */
  rebuild(): void {
    this.aml.geometry.dispose();
    this.aml.geometry = this.buildLeaflet(true);
    this.pml.geometry.dispose();
    this.pml.geometry = this.buildLeaflet(false);
    this.rebuildChordae();
    this.rebuildSeam();
  }

  private edgePoint(isAnterior: boolean, q: number): THREE.Vector3 {
    const phi0 = isAnterior ? -AML_SPAN : AML_SPAN;
    const phi1 = isAnterior ? AML_SPAN : Math.PI * 2 - AML_SPAN;
    let qe = q;
    if (!isAnterior && this.state.resected) {
      const w = this.resectionHalfWidth(1);
      const d = q - 0.5;
      qe = Math.abs(d) < w ? 0.5 : q - Math.sign(d) * w * this.state.resectionClosed;
    }
    return this.leafletPoint(phi0 + (phi1 - phi0) * qe, 1, isAnterior, qe);
  }

  private rebuildChordae(): void {
    for (const c of [...this.chordGroup.children]) { this.chordGroup.remove(c); (c as THREE.Mesh).geometry?.dispose(); }
    this.stump = null;
    const fans: { tip: THREE.Vector3; targets: THREE.Vector3[] }[] = [];
    const amlQ = [0.08, 0.2, 0.32, 0.42, 0.58, 0.68, 0.8, 0.92];
    const pmlQ = [0.06, 0.16, 0.26, 0.36, 0.44, 0.56, 0.64, 0.74, 0.84, 0.94];
    const ruptured = new Set([0.44, 0.56]);
    for (const tipSide of [1, -1]) {
      const tip = tipSide > 0 ? this.alpmTip : this.pmpmTip;
      const amlT = amlQ.filter((q) => (tipSide > 0 ? q > 0.5 : q < 0.5)).map((q) => this.edgePoint(true, q));
      const pmlT = pmlQ.filter((q) => (tipSide > 0 ? q < 0.5 : q > 0.5)).filter((q) => !(this.state.prolapse > 0.5 && !this.state.resected && ruptured.has(q))).map((q) => this.edgePoint(false, q));
      fans.push({ tip, targets: amlT.slice(0, 2) }, { tip, targets: amlT.slice(2) }, { tip, targets: pmlT.slice(0, 3) }, { tip, targets: pmlT.slice(3) });
    }
    for (const fan of fans) {
      if (!fan.targets.length) continue;
      const centroid = fan.targets.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / fan.targets.length);
      const branch = fan.tip.clone().lerp(centroid, 0.55);
      this.addChord(fan.tip, branch, 0.045);
      for (const t of fan.targets) this.addChord(branch, t, 0.028);
    }
    // ruptured chord stump hanging from the flail P2 edge
    if (this.state.prolapse > 0.5 && !this.state.resected) {
      const edge = this.edgePoint(false, 0.5);
      const end = edge.clone().add(new THREE.Vector3(0.1, -0.55, 0.15));
      this.stump = this.addChord(edge, end, 0.03);
      this.stump.name = 'ruptured-chord';
    }
  }

  private addChord(a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6, 1), chordMat);
    Overlays.placeCylinder(m, a, b, r);
    m.castShadow = true;
    this.chordGroup.add(m);
    return m;
  }

  private rebuildSeam(): void {
    if (this.resectionSeam) { this.group.remove(this.resectionSeam); this.resectionSeam = null; }
    if (!this.state.resected || this.state.resectionClosed < 0.05) return;
    const g = new THREE.Group();
    const steps = 6;
    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i <= steps; i++) {
      const v = 0.25 + 0.75 * (i / steps);
      const p = this.leafletPoint(Math.PI, v, false, 0.5).add(new THREE.Vector3(0, 0.02, 0));
      const knot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), new THREE.MeshStandardMaterial({ color: 0x3d7bd6, roughness: 0.4 }));
      knot.position.copy(p);
      knot.visible = i / steps <= this.state.resectionClosed + 0.01;
      g.add(knot);
      if (prev && knot.visible) {
        const th = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6), new THREE.MeshStandardMaterial({ color: 0x3d7bd6, roughness: 0.4 }));
        Overlays.placeCylinder(th, prev, p, 0.012);
        g.add(th);
      }
      prev = p;
    }
    this.resectionSeam = g;
    this.group.add(g);
  }

  // ---------------------------------------------------------------- repair API
  setNeochords(pairs: { from: THREE.Vector3; to: THREE.Vector3 }[]): void {
    for (const m of this.neochordMeshes) { this.group.remove(m); m.geometry.dispose(); }
    this.neochordMeshes = [];
    for (const p of pairs) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6), new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.45 }));
      Overlays.placeCylinder(m, p.from, p.to, 0.022);
      m.name = 'neochord';
      this.group.add(m);
      this.neochordMeshes.push(m);
    }
  }

  /** Neochords re-attached to the current free-edge position of P2. */
  refreshNeochords(): void {
    if (!this.neochordMeshes.length) return;
    const targets = [this.edgePoint(false, 0.47), this.edgePoint(false, 0.53)];
    this.neochordMeshes.forEach((m, i) => {
      const from = i === 0 ? this.alpmTip : this.pmpmTip;
      Overlays.placeCylinder(m, from, targets[Math.min(i, targets.length - 1)], 0.022);
    });
  }

  /** Reference length for a neochord from the given papillary tip to the P2 edge at coaptation level. */
  idealNeochordLength(fromAL: boolean): number {
    const saved = { ...this.state };
    this.state = { ...saved, closure: 1, neochordError: 0 };
    const edge = this.edgePoint(false, fromAL ? 0.47 : 0.53);
    this.state = saved;
    return (fromAL ? this.alpmTip : this.pmpmTip).distanceTo(edge);
  }

  /** Two trigones at the ends of the aorto-mitral curtain. */
  get trigones(): { al: THREE.Vector3; pm: THREE.Vector3 } {
    return { al: this.annulus(0.95), pm: this.annulus(-0.95) };
  }

  amlHeightPoints(): { hinge: THREE.Vector3; edge: THREE.Vector3 } {
    return { hinge: this.annulus(0), edge: this.edgePoint(true, 0.5) };
  }

  p2Edge(): THREE.Vector3 { return this.edgePoint(false, 0.5); }

  /** Corners of the planned triangular resection on P2 (free edge left/right and the apex). */
  resectionOutline(): THREE.Vector3[] {
    const w = this.resectionHalfWidth(1);
    const saved = this.state;
    this.state = { ...saved, resected: false };
    const pts = [this.edgePoint(false, 0.5 - w), this.leafletPoint(Math.PI, 0.24, false, 0.5), this.edgePoint(false, 0.5 + w)];
    this.state = saved;
    return pts;
  }

  /** Annular suture targets for ring implantation. */
  ringSutureTargets(count = 14): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const phi = (i / count) * Math.PI * 2;
      out.push(this.annulus(phi).add(new THREE.Vector3(0, 0.03, 0)));
    }
    return out;
  }

  /** Create the prosthetic ring (hovering above the annulus). */
  placeRing(size: number): void {
    if (this.ring) this.group.remove(this.ring);
    this.state.ringSize = size;
    this.state.ringSeated = 0;
    const g = new THREE.Group();
    const scale = size / 33;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 96; i++) {
      const phi = (i / 96) * Math.PI * 2;
      const a = this.annulus(phi, false);
      pts.push(new THREE.Vector3(a.x * scale * 1.02, a.y * 0.9, a.z * scale * 0.94));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 128, 0.13, 10, true), ringMat);
    tube.castShadow = true;
    g.add(tube);
    for (let i = 0; i < 12; i++) {
      const p = curve.getPointAt(i / 12);
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), ringDotMat);
      d.position.copy(p).add(new THREE.Vector3(0, 0.12, 0));
      g.add(d);
    }
    g.name = 'annuloplasty-ring';
    g.position.y = 2.2;
    this.ring = g;
    this.group.add(g);
  }

  /** Animate the ring down and remodel the annulus. */
  setRingSeated(f: number): void {
    this.state.ringSeated = f;
    if (this.ring) this.ring.position.y = 2.2 * (1 - f) + 0.06;
    this.rebuild();
  }

  setClosure(c: number): void {
    this.state.closure = c;
    this.rebuild();
    this.refreshNeochords();
  }

  /** Residual gap (cm) between leaflets at P2 during closure; positive = regurgitant. */
  regurgitation(): number {
    const st = this.state;
    if (!st.resected) return st.prolapse * 0.6;
    const err = st.neochordError ?? 0;
    return Math.max(0, Math.abs(err) - 0.08) + (st.ringSize == null ? 0.1 : 0);
  }

  setSaline(level: number, visible: boolean): void {
    this.salineLevel = level;
    this.saline.position.y = level;
    this.saline.visible = visible;
  }

  setJet(on: boolean): void { this.jet.visible = on; }

  update(dt: number): void {
    this.time += dt;
    if (this.stump) {
      const edge = this.edgePoint(false, 0.5);
      const sway = new THREE.Vector3(Math.sin(this.time * 2.1) * 0.12, -0.55, 0.15 + Math.cos(this.time * 1.7) * 0.1);
      Overlays.placeCylinder(this.stump, edge, edge.clone().add(sway), 0.03);
    }
    if (this.jet.visible) {
      const origin = this.p2Edge().add(new THREE.Vector3(0, 0.05, 0));
      for (let i = 0; i < 220; i++) {
        const o = i * 4;
        this.jetParams[o] = (this.jetParams[o] + dt * this.jetParams[o + 3]) % 1;
        const t = this.jetParams[o];
        this.dummy.position.set(origin.x + this.jetParams[o + 1] * (1 + t * 4), origin.y + t * 2.4, origin.z + this.jetParams[o + 2] * (1 + t * 4) - t * 0.4);
        this.dummy.scale.setScalar(1 - t * 0.6);
        this.dummy.updateMatrix();
        this.jet.setMatrixAt(i, this.dummy.matrix);
      }
      this.jet.instanceMatrix.needsUpdate = true;
    }
  }

  get pickables(): THREE.Object3D[] {
    return [this.aml, this.pml, this.papillaryAL, this.papillaryPM, this.cuff, ...(this.ring ? [this.ring] : [])];
  }
}
