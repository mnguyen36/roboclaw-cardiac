/**
 * Robotic instrument arm, modelled on a wristed laparoscopic instrument.
 *
 * Built from reference photographs of da Vinci EndoWrist tools: a black anodised shaft,
 * a clevis of two parallel plates carrying a brass pulley, and polished steel jaws that
 * taper and curve. The jaws articulate, so suturing and cutting are driven by real motion
 * of the tool rather than by fading overlays in and out.
 */
import * as THREE from 'three';

export type ToolKind = 'blade' | 'needle' | 'forceps' | 'hook' | 'scissors';

const shaftMat = new THREE.MeshPhysicalMaterial({ color: 0x1b1d20, metalness: 0.65, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.3 });
const clevisMat = new THREE.MeshPhysicalMaterial({ color: 0xb8bcc2, metalness: 1, roughness: 0.3 });
const steelMat = new THREE.MeshPhysicalMaterial({ color: 0xd8dce1, metalness: 1, roughness: 0.19 });
const bladeMat = new THREE.MeshPhysicalMaterial({ color: 0xeef2f6, metalness: 1, roughness: 0.08 });
const brassMat = new THREE.MeshPhysicalMaterial({ color: 0xc9a227, metalness: 1, roughness: 0.28 });

/**
 * One jaw: a tapered, slightly curved blade with a serrated gripping face.
 * Built as a lathe-like sweep so the silhouette matches the real instrument.
 */
function buildJaw(length: number, opts: { serrated: boolean; sharp: boolean; mirror?: boolean }): THREE.BufferGeometry {
  const segments = 14;
  const radial = 8;
  const m = opts.mirror ? -1 : 1;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // taper to a fine tip, with a gentle inward curve towards the opposing jaw
    const halfWidth = 0.042 * (1 - t * 0.7);
    const halfThick = (opts.sharp ? 0.016 : 0.026) * (1 - t * 0.55);
    const curve = t * t * 0.05;
    const y = -t * length;
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const px = Math.cos(a) * halfWidth;
      let pz = Math.sin(a) * halfThick;
      // serrations on the gripping face only
      if (opts.serrated && pz > 0) pz += Math.sin(t * segments * Math.PI * 1.6) * 0.007;
      positions.push(px, y, (pz + curve) * m);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = a + radial;
      const d = b + radial;
      // mirroring across z reverses handedness, so the winding flips with it
      if (opts.mirror) indices.push(a, b, c, b, d, c);
      else indices.push(a, c, b, b, c, d);
    }
  }
  const baseCenter = positions.length / 3;
  positions.push(0, 0, 0);
  for (let j = 0; j < radial; j++) {
    const next = (j + 1) % radial;
    if (opts.mirror) indices.push(baseCenter, j, next);
    else indices.push(baseCenter, next, j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

export class RobotArm {
  readonly group = new THREE.Group();
  private shaft: THREE.Mesh;
  private wrist: THREE.Group;
  /** Pitch/yaw joint that the jaws hang from. */
  private jawRoot = new THREE.Group();
  private jawA = new THREE.Group();
  private jawB = new THREE.Group();
  private tool: THREE.Object3D | null = null;
  private toolKind: ToolKind = 'needle';
  private targetTip = new THREE.Vector3();
  private targetNormal = new THREE.Vector3(0, 0, 1);
  private tip = new THREE.Vector3();
  private normal = new THREE.Vector3(0, 0, 1);
  private hasTarget = false;
  /** Current and commanded jaw opening in radians. */
  private jawAngle = 0.3;
  private jawTarget = 0.3;
  /** Roll of the wrist about the tool axis, used when driving a curved needle. */
  private rollAngle = 0;
  private rollTarget = 0;
  readonly port: THREE.Vector3;

  constructor(port: THREE.Vector3, kind: ToolKind = 'needle') {
    this.port = port.clone();
    this.group.name = 'robot-arm';

    // 8 mm instrument shaft, modelled slim so it occludes less of a millimetre-scale target
    this.shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1, 20, 1), shaftMat);
    this.shaft.castShadow = true;
    this.group.add(this.shaft);

    this.wrist = new THREE.Group();

    // Clevis: two narrow parallel plates carrying a brass pulley on the joint pin.
    const plate = new THREE.BoxGeometry(0.028, 0.22, 0.13);
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(plate, clevisMat);
      p.position.set(side * 0.05, -0.12, 0);
      p.castShadow = true;
      this.wrist.add(p);
    }
    const pulley = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.1, 14), brassMat);
    pulley.rotation.z = Math.PI / 2;
    pulley.position.set(0, -0.24, 0);
    this.wrist.add(pulley);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.16, 0.22, 18), clevisMat);
    collar.position.set(0, 0.02, 0);
    this.wrist.add(collar);

    this.jawRoot.position.set(0, -0.24, 0);
    this.wrist.add(this.jawRoot);
    this.jawRoot.add(this.jawA, this.jawB);

    this.group.add(this.wrist);
    this.setTool(kind);
    this.group.visible = false;
    this.tip.copy(port);
  }

  setPort(p: THREE.Vector3): void { this.port.copy(p); }

  private clearJaws(): void {
    for (const g of [this.jawA, this.jawB]) {
      for (const c of [...g.children]) { g.remove(c); (c as THREE.Mesh).geometry?.dispose(); }
    }
    if (this.tool) { this.jawRoot.remove(this.tool); this.tool = null; }
  }

  setTool(kind: ToolKind): void {
    this.clearJaws();
    this.toolKind = kind;
    const jawLen = kind === 'scissors' ? 0.5 : 0.42;
    const serrated = kind === 'needle' || kind === 'forceps';
    const sharp = kind === 'scissors';
    // A blade or hook is held in a collet, not between jaws, so the jaws are omitted there.
    if (kind !== 'blade' && kind !== 'hook') {
      const a = new THREE.Mesh(buildJaw(jawLen, { serrated, sharp }), sharp ? bladeMat : steelMat);
      const b = new THREE.Mesh(buildJaw(jawLen, { serrated, sharp, mirror: true }), sharp ? bladeMat : steelMat);
      a.castShadow = b.castShadow = true;
      this.jawA.add(a);
      this.jawB.add(b);
    }

    if (kind === 'blade') {
      // A beaver blade held in the jaws: flat, tapered, with a bevelled cutting edge.
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(0.075, -0.04);
      shape.lineTo(0.04, -0.52);
      shape.lineTo(0, -0.58);
      shape.lineTo(-0.016, -0.08);
      const holder = new THREE.Group();
      const blade = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.004, bevelSegments: 1 }), bladeMat);
      blade.position.set(0, 0, -0.006);
      blade.castShadow = true;
      const collet = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.13, 12), clevisMat);
      collet.position.set(0.02, 0.06, 0);
      holder.add(collet, blade);
      holder.position.set(0, -0.02, 0);
      // present the flat of the blade to the camera rather than its edge
      holder.rotation.set(0.32, 0.6, 0);
      this.tool = holder;
      this.jawRoot.add(holder);
      this.jawTarget = 0;
    } else if (kind === 'needle') {
      // 3/8-circle taper-point needle gripped across the jaw tips.
      const needle = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.014, 8, 26, Math.PI * 0.78), steelMat);
      needle.rotation.set(Math.PI / 2, 0, Math.PI * 0.6);
      needle.position.set(0.08, -0.38, 0);
      needle.castShadow = true;
      this.tool = needle;
      this.jawRoot.add(needle);
      this.jawTarget = 0.12;
    } else if (kind === 'hook') {
      const path = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, -0.02, 0), new THREE.Vector3(0, -0.42, 0),
        new THREE.Vector3(0.07, -0.6, 0), new THREE.Vector3(0.19, -0.56, 0),
      ]);
      const hook = new THREE.Mesh(new THREE.TubeGeometry(path, 14, 0.018, 6), steelMat);
      hook.castShadow = true;
      this.tool = hook;
      this.jawRoot.add(hook);
      this.jawTarget = 0.04;
    } else {
      this.jawTarget = 0.32;
    }
    this.jawAngle = this.jawTarget;
  }

  get kind(): ToolKind { return this.toolKind; }

  /** Distance from the wrist joint to the working tip along the tool's local -Y. */
  private get reach(): number {
    switch (this.toolKind) {
      case 'blade': return 0.85;
      case 'hook': return 0.85;
      case 'scissors': return 0.78;
      default: return 0.68;
    }
  }

  show(v: boolean): void { this.group.visible = v; }

  /** Command the jaws: 0 closed, 1 fully open. */
  setJaw(open: number): void {
    const max = this.toolKind === 'scissors' ? 0.5 : this.toolKind === 'blade' ? 0.08 : 0.42;
    this.jawTarget = THREE.MathUtils.clamp(open, 0, 1) * max;
  }

  /** Roll the wrist about the tool axis, for driving a curved needle through tissue. */
  setRoll(radians: number): void { this.rollTarget = radians; }

  setTarget(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.targetTip.copy(point);
    this.targetNormal.copy(normal).normalize();
    if (!this.hasTarget) { this.tip.copy(point); this.normal.copy(this.targetNormal); this.hasTarget = true; }
  }

  park(point: THREE.Vector3): void {
    this.targetTip.copy(point);
    this.targetNormal.set(0, 1, 0);
    if (!this.hasTarget) { this.tip.copy(point); this.hasTarget = true; }
  }

  update(dt: number, follow = 18): void {
    if (!this.hasTarget) return;
    const k = 1 - Math.exp(-follow * dt);
    this.tip.lerp(this.targetTip, k);
    this.normal.lerp(this.targetNormal, k).normalize();
    // jaws and roll converge faster than the arm, so a bite reads as a distinct action
    const jk = 1 - Math.exp(-22 * dt);
    this.jawAngle += (this.jawTarget - this.jawAngle) * jk;
    this.rollAngle += (this.rollTarget - this.rollAngle) * jk;

    const toPort = this.port.clone().sub(this.tip).normalize();
    const lean = this.normal.clone().multiplyScalar(0.6).add(toPort.multiplyScalar(0.7)).normalize();
    const wristPos = this.tip.clone().addScaledVector(lean, this.reach);
    this.wrist.position.copy(wristPos);
    const down = this.tip.clone().sub(wristPos).normalize();
    this.wrist.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), down);
    if (this.rollAngle !== 0) {
      this.wrist.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rollAngle));
    }

    const shaftDir = wristPos.clone().sub(this.port);
    const len = shaftDir.length();
    this.shaft.position.copy(this.port).addScaledVector(shaftDir, 0.5);
    this.shaft.scale.set(1, len, 1);
    this.shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), shaftDir.normalize());

    this.jawA.rotation.x = -this.jawAngle;
    this.jawB.rotation.x = this.jawAngle;
  }

  get tipPosition(): THREE.Vector3 { return this.tip; }
  get jawOpening(): number { return this.jawAngle; }
}
