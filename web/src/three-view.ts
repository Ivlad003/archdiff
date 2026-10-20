// The picture in 3D: each lane a terrace raised by its order (the first
// lane, the top one of the canvas, the highest), each shape a block on
// its terrace with the footprint it has on the canvas, each line a tube
// arched from block to block with an arrowhead, every label a sprite
// above its block. A sequence keeps its time: the participants stand at
// the back, each message runs along its own route at its own depth, the
// lifelines run from the participants to the front, and a fragment is a
// frame on the ground. Built with three.js from the laid-out picture the
// server sends, in the colours the Excalidraw export draws with, so the
// scene is the same picture as the canvas. The mouse orbits (drag turns,
// wheel zooms, right-drag pans); a tap on a block is a tap on the shape,
// a double tap opens its own view. One renderer lives in the box for the
// page's life; the scene is rebuilt for every picture, and again when the
// theme changes. Loaded as a chunk of its own when the centre first shows
// 3D (presentation.ts).
//
// Entry points: `showThree`, `hideThree`, `fitThree`, `threeState`.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Diagram, Lane, Line, Shape } from "./api.ts";
import { lineStroke, lookOf } from "../../src/looks.ts";

/** What a tap and a double tap on a block do: what the canvas's taps do. */
export interface ThreeEvents {
  pick(id: string | null): void;
  open(id: string): void;
}

/** How high a lane rises over the one below it, and how thick a terrace is, in the canvas's pixels. */
const RISE = 150;
const TERRACE = 6;
/** How high over the ground a line drawn along its route runs (a message of a sequence), and how thick. */
const ROUTED = { lift: 8, radius: 1.4, lifeline: 0.6 };
/** The height of a block by the kind of its shape; a kind not listed (a frame, an anchor) is not drawn as a block. */
const HEIGHTS: Partial<Record<Shape["kind"], number>> = { layer: 24, module: 18, fn: 14, external: 12, hole: 14, start: 12, more: 10, participant: 14, event: 12, cell: 8, package: 20, class: 20, state: 14, machine: 14, decision: 14, action: 12, end: 12 };
/** Where the camera looks from when the scene is fitted: from the front, the right and above. */
const VIEWPOINT = new THREE.Vector3(0.65, 0.75, 1).normalize();
/** A tap: a press and a release within this many pixels and milliseconds. */
const TAP = { px: 6, ms: 400 };
/** The labels: the font of a block's and a lane's, how many characters of a label are drawn, and their size in the scene. */
const LABEL = { block: 28, lane: 36, chars: 40, scale: 0.7 };
/** A terrace reaches this far beyond the blocks on it: the lane's own width spans the whole picture, which would dwarf them. */
const TERRACE_MARGIN = 36;
/** The glow of the picked block. */
const PICKED = new THREE.Color("#ff6f00");

interface Mount {
  box: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  raycaster: THREE.Raycaster;
  observer: ResizeObserver;
  /** The blocks by the ID of their shape, and all of them for the raycaster. */
  blocks: Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>>;
  /** What the scene holds, for the fit and the tests. */
  bounds: THREE.Box3;
  view: string | null;
  diagram: Diagram | null;
  lanes: number;
  lines: number;
  picked: string | null;
  events: ThreeEvents | null;
}

let mount: Mount | null = null;
/** Why no scene can be drawn: the browser gives no WebGL. */
let failure: string | null = null;

/** The value of a CSS variable of the page's theme (page.css), or the fallback. */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  return value === "" ? fallback : value;
}

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** The renderer, the camera and the controls in the box, made once; null when the browser has no WebGL (the box says so). */
function mounted(box: HTMLElement): Mount | null {
  if (mount) return mount;

  if (failure !== null) return null;
  let renderer: THREE.WebGLRenderer;

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (error) {
    failure = `3D needs WebGL, which this browser does not provide (${error instanceof Error ? error.message : String(error)})`;
    box.replaceChildren(Object.assign(document.createElement("div"), { className: "note", textContent: failure }));

    return null;
  }

  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(box.clientWidth, box.clientHeight);
  box.replaceChildren(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(45, Math.max(1, box.clientWidth) / Math.max(1, box.clientHeight), 1, 100_000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  const m: Mount = { box, renderer, scene: new THREE.Scene(), camera, controls, raycaster: new THREE.Raycaster(), observer: new ResizeObserver(() => resized()), blocks: new Map(), bounds: new THREE.Box3(), view: null, diagram: null, lanes: 0, lines: 0, picked: null, events: null };
  mount = m;
  controls.addEventListener("change", () => render());
  m.observer.observe(box);
  listenForTaps(m);
  // The theme changed: the same picture, in the new colours.
  new MutationObserver(() => {
    if (!box.hidden && m.diagram && m.view !== null) build(m, m.diagram);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  return m;
}

/** The box changed size (the panels folded, the window resized): the picture keeps its place in it. */
function resized(): void {
  if (!mount || mount.box.hidden) return;
  const { box, renderer, camera } = mount;

  if (box.clientWidth === 0 || box.clientHeight === 0) return;
  renderer.setSize(box.clientWidth, box.clientHeight);
  camera.aspect = box.clientWidth / box.clientHeight;
  camera.updateProjectionMatrix();
  render();
}

function render(): void {
  if (mount && !mount.box.hidden) mount.renderer.render(mount.scene, mount.camera);
}

/** A tap on a block picks its shape (a tap on nothing picks nothing); a double tap opens the shape's view. */
function listenForTaps(m: Mount): void {
  const canvas = m.renderer.domElement;
  let pressed: { x: number; y: number; at: number } | null = null;
  canvas.addEventListener("pointerdown", (event) => {
    pressed = event.button === 0 ? { x: event.clientX, y: event.clientY, at: performance.now() } : null;
  });
  canvas.addEventListener("pointerup", (event) => {
    const press = pressed;
    pressed = null;

    if (!press || Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP.px || performance.now() - press.at > TAP.ms) return;
    const id = blockAt(m, event.clientX, event.clientY);
    highlight(m, id);
    m.events?.pick(id);
  });
  canvas.addEventListener("dblclick", (event) => {
    const id = blockAt(m, event.clientX, event.clientY);

    if (id !== null) m.events?.open(id);
  });
  canvas.addEventListener("pointermove", (event) => {
    canvas.style.cursor = blockAt(m, event.clientX, event.clientY) === null ? "" : "pointer";
  });
}

/** The shape of the block under a point of the screen, the nearest when blocks overlap; null over a terrace or the sky. */
function blockAt(m: Mount, clientX: number, clientY: number): string | null {
  const rect = m.renderer.domElement.getBoundingClientRect();

  if (rect.width === 0 || rect.height === 0) return null;
  const point = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  m.raycaster.setFromCamera(point, m.camera);
  const hit = m.raycaster.intersectObjects([...m.blocks.values()], false)[0];
  const id = hit?.object.userData["id"];

  return typeof id === "string" ? id : null;
}

/** The picked block glows; the others do not. */
function highlight(m: Mount, id: string | null): void {
  m.picked = id;

  for (const [blockId, block] of m.blocks) {
    block.material.emissive.set(blockId === id ? PICKED : 0x000000);
    block.material.emissiveIntensity = 0.35;
  }

  render();
}

/** Frees everything of the scene: geometries, materials, textures. */
function clearScene(m: Mount): void {
  m.scene.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Sprite) {
      (object.geometry as THREE.BufferGeometry).dispose();
      const materials = Array.isArray(object.material) ? (object.material as THREE.Material[]) : [object.material as THREE.Material];

      for (const material of materials) {
        if ("map" in material && material.map instanceof THREE.Texture) material.map.dispose();
        material.dispose();
      }
    }
  });
  m.scene.clear();
  m.blocks.clear();
  m.lanes = 0;
  m.lines = 0;
  m.picked = null;
}

/** A rectangle of the canvas: a lane's, or the room a lane's blocks take. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The room the shapes of a lane take, with a margin around them: the terrace under them. Null for a lane with no shape drawn. */
function roomOf(shapes: readonly Shape[]): Rect | null {
  if (shapes.length === 0) return null;
  const left = Math.min(...shapes.map((node) => node.x)) - TERRACE_MARGIN;
  const top = Math.min(...shapes.map((node) => node.y)) - TERRACE_MARGIN;
  const right = Math.max(...shapes.map((node) => node.x + node.w)) + TERRACE_MARGIN;
  const bottom = Math.max(...shapes.map((node) => node.y + node.h)) + TERRACE_MARGIN;

  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** A terrace: a slab at the lane's level under the room its blocks take, with the lane's label at its top-left corner. */
function terrace(lane: Lane, room: Rect, level: number, dark: boolean): THREE.Object3D[] {
  const slab = new THREE.Mesh(new THREE.BoxGeometry(room.w, TERRACE, room.h), new THREE.MeshLambertMaterial({ color: dark ? "#37474f" : "#eceff1", transparent: true, opacity: 0.92 }));
  slab.position.set(room.x + room.w / 2, level - TERRACE / 2, room.y + room.h / 2);
  slab.add(new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), new THREE.LineBasicMaterial({ color: dark ? "#78909c" : "#90a4ae" })));
  // The lane's name floats above the corner, over the blocks' own labels, so a block in the corner does not cover it.
  const label = labelSprite(lane.label, LABEL.lane, dark);
  label.position.set(room.x + label.scale.x / 2 + 8, level + label.scale.y / 2 + 40, room.y + 10);

  return [slab, label];
}

/** A block: the shape's footprint, its kind's outline (a box, a cylinder for an ellipse, a diamond), in its look's colours; a removed shape is see-through. */
function block(node: Shape, height: number, level: number): THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> {
  const look = lookOf(node);
  const geometry = look.type === "ellipse" ? new THREE.CylinderGeometry(0.5, 0.5, 1, 40) : look.type === "diamond" ? new THREE.OctahedronGeometry(0.5) : new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshLambertMaterial({ color: look.fill === "transparent" ? "#ffffff" : look.fill, transparent: node.diff === "removed", opacity: node.diff === "removed" ? 0.45 : 1 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(node.w, height, node.h);
  mesh.position.set(node.x + node.w / 2, level + height / 2, node.y + node.h / 2);
  mesh.userData["id"] = node.id;
  // The outline in the stroke's colour; a change's mark is a thicker stroke, drawn as a second outline a little outside the first.
  const outline = new THREE.EdgesGeometry(geometry);
  mesh.add(new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ color: look.stroke })));

  if (look.width > 1) {
    const second = new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ color: look.stroke }));
    second.scale.set(1.03, 1.06, 1.03);
    mesh.add(second);
  }

  return mesh;
}

/** An arrowhead at the end of a line: a cone pointing along the tangent, sized by the line's radius. */
function arrowhead(end: THREE.Vector3, tangent: THREE.Vector3, radius: number, colour: THREE.Color): THREE.Mesh {
  const head = new THREE.Mesh(new THREE.ConeGeometry(radius * 3 + 4, 16, 12), new THREE.MeshBasicMaterial({ color: colour }));
  head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
  head.position.copy(end).sub(tangent.clone().multiplyScalar(7));

  return head;
}

/** A label as a sprite, always facing the camera: the first line of the text, cut when long, in the theme's colour. */
function labelSprite(text: string, px: number, dark: boolean): THREE.Sprite {
  const line = (text.split("\n")[0] ?? "").trim();
  const shown = line.length > LABEL.chars ? `${line.slice(0, LABEL.chars - 1)}…` : line;
  const ratio = Math.min(devicePixelRatio, 2);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  const font = `600 ${px}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  context.font = font;
  const width = Math.ceil(context.measureText(shown).width) + 12;
  const height = Math.ceil(px * 1.4);
  canvas.width = Math.max(1, width * ratio);
  canvas.height = Math.max(1, height * ratio);
  context.scale(ratio, ratio);
  context.font = font;
  context.textBaseline = "middle";
  context.fillStyle = dark ? "#eceff1" : "#1e1e1e";
  context.fillText(shown, 6, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(width * LABEL.scale, height * LABEL.scale, 1);
  sprite.renderOrder = 1;

  return sprite;
}

/** A line drawn along the route the picture gave it (a sequence's message, a lifeline), just over the ground, in the line's colour; a message ends in an arrowhead. */
function routed(edge: Line, route: readonly { x: number; y: number }[], level: number): THREE.Object3D[] {
  const points = route.map((point) => new THREE.Vector3(point.x, level + ROUTED.lift, point.y));

  if (points.length < 2) return [];
  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0);
  const colour = new THREE.Color(lineStroke(edge));
  const radius = edge.kind === "lifeline" ? ROUTED.lifeline : ROUTED.radius + Math.min(edge.count ?? 1, 8) * 0.2;
  const body = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, points.length * 6), radius, 6, false), new THREE.MeshBasicMaterial({ color: colour, transparent: edge.kind === "lifeline", opacity: edge.kind === "lifeline" ? 0.6 : 1 }));

  if (edge.kind === "lifeline") return [body];
  const end = points[points.length - 1]!;

  return [body, arrowhead(end, end.clone().sub(points[points.length - 2]!).normalize(), radius, colour)];
}

/** A frame (a fragment of a sequence): its rectangle drawn on the ground as an outline, its label at the corner. */
function frame(node: Shape, level: number, dark: boolean): THREE.Object3D[] {
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(node.w, 1, node.h)), new THREE.LineBasicMaterial({ color: lookOf(node).stroke }));
  outline.position.set(node.x + node.w / 2, level + 1, node.y + node.h / 2);
  const label = labelSprite(node.label, LABEL.block, dark);
  label.position.set(node.x + label.scale.x / 2 + 6, level + label.scale.y / 2 + 4, node.y + 8);

  return [outline, label];
}

/** A line as a tube arched from the top of one block to the top of the other, in the line's colour, with an arrowhead at the end. */
function tube(edge: Line, from: THREE.Mesh, to: THREE.Mesh): THREE.Object3D[] {
  const start = new THREE.Vector3(from.position.x, from.position.y + from.scale.y / 2, from.position.z);
  const end = new THREE.Vector3(to.position.x, to.position.y + to.scale.y / 2, to.position.z);
  const distance = start.distanceTo(end);
  // The arch rises with the distance, over the higher end, so a line between terraces clears the upper one.
  const control = start.clone().add(end).multiplyScalar(0.5);
  control.y = Math.max(start.y, end.y) + 30 + distance * 0.15;
  const curve = new THREE.QuadraticBezierCurve3(start, control, end);
  const radius = 1.2 + Math.min(edge.count ?? 1, 8) * 0.25;
  const colour = new THREE.Color(lineStroke(edge));
  const body = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, radius, 6, false), new THREE.MeshBasicMaterial({ color: colour }));

  return [body, arrowhead(end, curve.getTangent(1).normalize(), radius, colour)];
}

/** The scene of a diagram: the terraces, the blocks with their labels, the tubes; then the camera fitted to it. */
function build(m: Mount, diagram: Diagram): void {
  clearScene(m);
  const dark = isDark();
  m.scene.background = new THREE.Color(cssVar("--bg", dark ? "#1b1b1b" : "#ffffff"));
  m.scene.add(new THREE.AmbientLight(0xffffff, dark ? 1.2 : 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, dark ? 1.4 : 1.8);
  sun.position.set(0.4, 1, 0.6);
  m.scene.add(sun);

  // The lanes in their order, the first (the top one of the canvas, or the left one) the highest; a terrace under the
  // blocks of each lane that has any.
  const lanes = diagram.groups.filter((lane) => lane.kind === "lane" && lane.w > 0 && lane.h > 0);
  const levelOf = new Map(lanes.map((lane, index) => [lane.id, (lanes.length - 1 - index) * RISE]));
  const drawn = diagram.nodes.filter((node) => HEIGHTS[node.kind] !== undefined && node.w > 0 && node.h > 0);

  for (const lane of lanes) {
    const room = roomOf(drawn.filter((node) => node.group === lane.id));

    if (!room) continue;
    m.scene.add(...terrace(lane, room, levelOf.get(lane.id)!, dark));
    m.lanes++;
  }

  // The shapes: a block on its lane's terrace (on the ground when it has none), its label floating above it.
  for (const node of drawn) {
    const height = HEIGHTS[node.kind]!;
    const level = node.group === undefined ? 0 : (levelOf.get(node.group) ?? 0);
    const mesh = block(node, height, level);
    m.blocks.set(node.id, mesh);
    m.scene.add(mesh);
    const label = labelSprite(node.label, LABEL.block, dark);
    label.position.set(mesh.position.x, level + height + label.scale.y / 2 + 6, mesh.position.z);
    m.scene.add(label);
  }

  // A sequence keeps its time: the messages run along their routes at their own depth, the lifelines to the front,
  // the fragments as frames on the ground. Any other picture's lines arch from block to block.
  const sequence = diagram.sequence !== undefined;

  for (const edge of diagram.edges) {
    if (sequence && edge.route && (edge.kind === "message" || edge.kind === "lifeline")) {
      m.scene.add(...routed(edge, edge.route, 0));

      if (edge.kind === "message") m.lines++;
      continue;
    }

    const from = m.blocks.get(edge.from);
    const to = m.blocks.get(edge.to);

    if (!from || !to || from === to || edge.kind === "lifeline") continue;
    m.scene.add(...tube(edge, from, to));
    m.lines++;
  }

  for (const node of diagram.nodes) if (node.kind === "fragment" && node.w > 0 && node.h > 0) m.scene.add(...frame(node, 0, dark));

  m.bounds = new THREE.Box3();

  for (const object of m.scene.children) if (object instanceof THREE.Mesh) m.bounds.expandByObject(object);

  if (m.bounds.isEmpty()) m.bounds.set(new THREE.Vector3(-100, 0, -100), new THREE.Vector3(100, 10, 100));
}

/** The picture of `view` in the box, from its laid-out diagram; drawn afresh, fitted, and listening for taps. */
export function showThree(box: HTMLElement, view: string, diagram: Diagram, events: ThreeEvents): void {
  const m = mounted(box);

  if (!m) return;
  m.events = events;
  m.view = view;
  m.diagram = diagram;
  resized();
  build(m, diagram);
  fitThree();
}

/** The scene put away (the centre shows something else, or no picture came): what it held is freed and the frame cleared; the renderer waits for the next picture. */
export function hideThree(): void {
  if (!mount) return;
  clearScene(mount);
  mount.view = null;
  mount.diagram = null;
  mount.events = null;
  mount.renderer.clear();
}

/**
 * The camera where the whole scene is in sight, looking from the viewpoint at its middle: first at the distance the
 * scene's sphere needs, then closer, as far as the scene's corners still fall within the view — a long, flat scene
 * (terraces side by side) fills the box instead of floating small in it.
 */
export function fitThree(): void {
  if (!mount || mount.box.hidden) return;
  const { camera, controls, bounds } = mount;
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 50);
  let distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.08;
  // The corners of every block, terrace and tube, not of the scene's box: seen from a corner, a staircase of terraces
  // leaves the box's far corners empty, and fitting those would leave the scene small in the middle.
  const corners: THREE.Vector3[] = [];

  for (const object of mount.scene.children) {
    if (!(object instanceof THREE.Mesh)) continue;
    const box = new THREE.Box3().setFromObject(object);

    for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
  }
  const place = (): void => {
    camera.position.copy(sphere.center).add(VIEWPOINT.clone().multiplyScalar(distance));
    camera.near = Math.max(0.5, distance / 200);
    camera.far = distance * 20;
    camera.lookAt(sphere.center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };

  // Twice: the projection is not linear in the distance, and the second pass lands within a few percent.
  for (let pass = 0; pass < 2; pass++) {
    place();
    const reach = Math.max(...corners.map((corner) => {
      const projected = corner.clone().project(camera);

      return Math.max(Math.abs(projected.x), Math.abs(projected.y));
    }));

    if (reach > 0) distance *= Math.max(reach, 0.2) * 1.06;
  }

  place();
  controls.target.copy(sphere.center);
  controls.update();
  render();
}

/** What the scene holds, for the browser tests: whether WebGL is there, the view drawn, the counts, the picked shape, and where the camera stands. */
export function threeState(): { webgl: boolean; view: string | null; shapes: number; lines: number; lanes: number; picked: string | null; camera: { distance: number; size: number[]; box: number[] } | null } {
  const camera = mount ? { distance: mount.camera.position.distanceTo(mount.controls.target), size: mount.bounds.getSize(new THREE.Vector3()).toArray().map(Math.round), box: [mount.box.clientWidth, mount.box.clientHeight] } : null;

  return { webgl: failure === null, view: mount?.view ?? null, shapes: mount?.blocks.size ?? 0, lines: mount?.lines ?? 0, lanes: mount?.lanes ?? 0, picked: mount?.picked ?? null, camera };
}
