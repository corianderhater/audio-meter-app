import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { aggregateToBands, buildBands } from "../audio/bands";
import { getAWeightingOffsets } from "../audio/aWeighting";

interface Props {
  analyser: AnalyserNode;
  sampleRate: number;
  fftSize: number;
  calibrationDb: number;
  theme: "light" | "dark";
}

const FLOOR_DB = -90;
const TOP_DB = 0;
const BANDS = 96;
const ROWS = 64;
const SAMPLE_HZ = 30;

const MESH_WIDTH = 6;
const MESH_DEPTH = 6;
const MAX_HEIGHT = 1.6;

// Real 3D wavefield mesh. Plane geometry subdivided BANDS × ROWS; each
// frame the heightmap shifts one row "into the distance" (-Z) and the
// front edge (+Z, closest to camera) gets the new spectrum slice. Standard
// PBR material lit by one directional + one ambient light. OrbitControls
// for drag-to-rotate / pinch-zoom.
export function Wavefield({
  analyser,
  sampleRate,
  fftSize,
  calibrationDb,
  theme,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const calRef = useRef(calibrationDb);
  calRef.current = calibrationDb;

  const layout = useMemo(
    () => buildBands(sampleRate, fftSize, BANDS),
    [sampleRate, fftSize],
  );
  const weights = useMemo(
    () => getAWeightingOffsets(sampleRate, fftSize),
    [sampleRate, fftSize],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const dark = theme === "dark";
    const bg = dark ? 0x000000 : 0xffffff;
    // Hill-shader gradient: low elevation → one shade, peaks → the other.
    // Light theme: valleys white-ish, peaks dark (topographic).
    // Dark theme:  valleys black-ish, peaks white (luminous).
    const lowGrey = dark ? 0.06 : 0.92;
    const highGrey = dark ? 1.0 : 0.12;

    // ─── renderer ───────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(bg, 1);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    // ─── scene + camera ─────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(bg);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 4.2, 6.5);
    camera.lookAt(0, 0, 0);

    // ─── lights (always white — colour comes from vertex colours) ───
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
    dirLight.position.set(3, 6, 4);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
    fillLight.position.set(-4, 3, -2);
    scene.add(fillLight);
    scene.add(new THREE.AmbientLight(0xffffff, 0.45));

    // ─── mesh ───────────────────────────────────────────────────────
    const geometry = new THREE.PlaneGeometry(
      MESH_WIDTH,
      MESH_DEPTH,
      BANDS - 1,
      ROWS - 1,
    );
    geometry.rotateX(-Math.PI / 2); // lie flat on XZ; Y is now "up"
    const positionAttr = geometry.attributes.position as THREE.BufferAttribute;

    // Per-vertex colour buffer — drives the hill shader.
    const colorArr = new Float32Array(BANDS * ROWS * 3);
    for (let k = 0; k < BANDS * ROWS; k++) {
      colorArr[k * 3] = lowGrey;
      colorArr[k * 3 + 1] = lowGrey;
      colorArr[k * 3 + 2] = lowGrey;
    }
    const colorAttr = new THREE.BufferAttribute(colorArr, 3);
    geometry.setAttribute("color", colorAttr);

    const material = new THREE.MeshStandardMaterial({
      // White base; per-vertex colours multiply against this.
      color: 0xffffff,
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0.05,
      flatShading: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    // ─── controls ───────────────────────────────────────────────────
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.minDistance = 3;
    controls.maxDistance = 14;
    controls.minPolarAngle = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.05; // never view from underneath
    controls.enablePan = false;

    // ─── resize ─────────────────────────────────────────────────────
    const resize = () => {
      const r = container.getBoundingClientRect();
      const w = Math.max(1, r.width);
      const h = Math.max(1, r.height);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // ─── data + animation ───────────────────────────────────────────
    // Heightmap laid out row-major matching PlaneGeometry vertex order:
    // index = row * BANDS + col.  Row 0 = front (+Z), newest data lands here.
    const heights = new Float32Array(BANDS * ROWS);
    const freq = new Float32Array(fftSize / 2);
    const bandDb = new Float32Array(BANDS);

    const sampleIntervalMs = 1000 / SAMPLE_HZ;
    let acc = 0;
    let last = performance.now();
    let raf = 0;

    const writeHeightsToMesh = () => {
      const arr = positionAttr.array as Float32Array;
      // Y-component lives at index 3k + 1; colour stride is 3 (rgb).
      const span = highGrey - lowGrey;
      for (let k = 0; k < BANDS * ROWS; k++) {
        const h = heights[k];
        arr[k * 3 + 1] = h;
        const t = Math.min(1, Math.max(0, h / MAX_HEIGHT));
        const g = lowGrey + span * t;
        colorArr[k * 3] = g;
        colorArr[k * 3 + 1] = g;
        colorArr[k * 3 + 2] = g;
      }
      positionAttr.needsUpdate = true;
      colorAttr.needsUpdate = true;
      geometry.computeVertexNormals();
    };

    const tick = (now: number) => {
      acc += now - last;
      last = now;

      let didShift = false;
      while (acc >= sampleIntervalMs) {
        acc -= sampleIntervalMs;

        // 1. read FFT and aggregate to log bands
        analyser.getFloatFrequencyData(freq);
        aggregateToBands(freq, weights, layout, bandDb);

        // 2. shift heightmap one row toward the back (-Z) — single
        //    typed-array copy, very fast.
        heights.copyWithin(BANDS, 0, (ROWS - 1) * BANDS);

        // 3. write the new front row from the new spectrum slice
        const cal = calRef.current;
        for (let i = 0; i < BANDS; i++) {
          const v = bandDb[i] + cal;
          const t = Math.min(
            1,
            Math.max(0, (v - FLOOR_DB) / (TOP_DB - FLOOR_DB)),
          );
          heights[i] = t * MAX_HEIGHT;
        }
        didShift = true;
      }

      if (didShift) {
        writeHeightsToMesh();
      }

      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // ─── cleanup ────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [analyser, fftSize, layout, weights, theme]);

  return <div ref={containerRef} className="spectrum wavefield" />;
}
