import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { aggregateToBands, buildBands } from "../audio/bands";
import { getAWeightingOffsets } from "../audio/aWeighting";
import { ProbePin, type ProbeData } from "./ProbeTooltip";

interface Props {
  analyser: AnalyserNode;
  sampleRate: number;
  fftSize: number;
  calibrationDb: number;
  theme: "light" | "dark";
}

const FLOOR_DB = 0;
const TOP_DB = 130;
// Higher subdivision → finer surface. With smoothing on top, this looks
// continuous rather than faceted at typical viewing distances.
const BANDS = 128;
const ROWS = 96;
const SAMPLE_HZ = 30;

const MESH_WIDTH = 6;
const MESH_DEPTH = 6;
const MAX_HEIGHT = 1.6;

type MaterialMode = "grayscale" | "chrome" | "texture" | "camera";

export function Wavefield({
  analyser,
  sampleRate,
  fftSize,
  calibrationDb,
  theme,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const calRef = useRef(calibrationDb);
  calRef.current = calibrationDb;

  const [materialMode, setMaterialMode] = useState<MaterialMode>("grayscale");
  const [textureUrl, setTextureUrl] = useState<string | null>(null);
  const [cameraFacing, setCameraFacing] = useState<"user" | "environment">(
    "environment",
  );

  // Probe — raycasts against the deformed mesh and reports (freq, dB SPL)
  // at the touched surface point. Refs let the rAF loop write the live SPL
  // value without re-rendering React.
  const [probe, setProbe] = useState<ProbeData | null>(null);
  const probeDbRef = useRef<HTMLDivElement>(null);
  const probePinRef = useRef<HTMLDivElement>(null);
  // Probe state shared with the rAF loop (band index + row of the picked
  // vertex) so we can read live amplitude from the heightmap each frame.
  const probeCellRef = useRef<{ band: number; row: number } | null>(null);
  // Imperative pick function set by the effect — exposes Three.js raycaster
  // + camera + mesh to the React handler outside the effect.
  const pickRef = useRef<
    | ((cssX: number, cssY: number) =>
        | { band: number; row: number; freqHz: number }
        | null)
    | null
  >(null);

  const layout = useMemo(
    () => buildBands(sampleRate, fftSize, BANDS),
    [sampleRate, fftSize],
  );
  const weights = useMemo(
    () => getAWeightingOffsets(sampleRate, fftSize),
    [sampleRate, fftSize],
  );

  // Heightmap survives across remounts (theme / material switch). Keeps the
  // surface populated instead of resetting to flat each time.
  const heightsRef = useRef<Float32Array | null>(null);
  if (!heightsRef.current) {
    heightsRef.current = new Float32Array(BANDS * ROWS);
  }

  const handleTextureClick = () => {
    // Already in texture mode → clicking again means "change picture".
    // Other modes with an existing texture → just switch back to texture.
    // No texture yet → open picker.
    if (materialMode === "texture" || !textureUrl) {
      fileInputRef.current?.click();
    } else {
      setMaterialMode("texture");
    }
  };

  const handleTextureChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const url = ev.target?.result;
      if (typeof url === "string") {
        setTextureUrl(url);
        setMaterialMode("texture");
      }
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const heights = heightsRef.current!;

    const dark = theme === "dark";
    const bg = dark ? 0x000000 : 0xffffff;
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

    // ─── lights ─────────────────────────────────────────────────────
    // Chrome mode dims the white lights and adds coloured point lights so the
    // metallic surface catches saturated highlights. Other modes use bright
    // white lighting so the surface (or texture) reads naturally.
    const isChrome = materialMode === "chrome";
    const dirLight = new THREE.DirectionalLight(0xffffff, isChrome ? 0.35 : 1.6);
    dirLight.position.set(3, 6, 4);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, isChrome ? 0.12 : 0.5);
    fillLight.position.set(-4, 3, -2);
    scene.add(fillLight);
    scene.add(new THREE.AmbientLight(0xffffff, isChrome ? 0.08 : 0.45));

    const colorLights: THREE.PointLight[] = [];
    if (isChrome) {
      const lightSpecs: Array<{
        color: number;
        position: [number, number, number];
      }> = [
        { color: 0xff2266, position: [5, 3, 1] },     // magenta-right
        { color: 0x00ffaa, position: [-5, 3, 1] },    // teal-left
        { color: 0x3366ff, position: [0, 4, -5] },    // blue-back
        { color: 0xffaa22, position: [0, 4, 5] },     // amber-front
      ];
      for (const spec of lightSpecs) {
        const l = new THREE.PointLight(spec.color, 14, 22, 1.4);
        l.position.set(...spec.position);
        scene.add(l);
        colorLights.push(l);
      }
    }

    // ─── geometry + material ────────────────────────────────────────
    const geometry = new THREE.PlaneGeometry(
      MESH_WIDTH,
      MESH_DEPTH,
      BANDS - 1,
      ROWS - 1,
    );
    geometry.rotateX(-Math.PI / 2);
    const positionAttr = geometry.attributes.position as THREE.BufferAttribute;

    const colorArr = new Float32Array(BANDS * ROWS * 3);
    for (let k = 0; k < BANDS * ROWS; k++) {
      colorArr[k * 3] = lowGrey;
      colorArr[k * 3 + 1] = lowGrey;
      colorArr[k * 3 + 2] = lowGrey;
    }
    const colorAttr = new THREE.BufferAttribute(colorArr, 3);
    geometry.setAttribute("color", colorAttr);

    let texture: THREE.Texture | null = null;
    let videoStream: MediaStream | null = null;
    let videoEl: HTMLVideoElement | null = null;
    let cancelled = false;
    let material: THREE.MeshStandardMaterial;

    if (materialMode === "chrome") {
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: false,
        side: THREE.DoubleSide,
        roughness: 0.08,
        metalness: 1.0,
        flatShading: false,
      });
    } else if (materialMode === "texture" && textureUrl) {
      texture = new THREE.TextureLoader().load(textureUrl);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: texture,
        vertexColors: false,
        side: THREE.DoubleSide,
        roughness: 0.55,
        metalness: 0.05,
        flatShading: false,
      });
    } else if (materialMode === "camera") {
      // Material starts white; the live video texture is attached when the
      // camera stream resolves. Permission was authorised by the user gesture
      // that switched to this mode.
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: false,
        side: THREE.DoubleSide,
        roughness: 0.55,
        metalness: 0.05,
        flatShading: false,
      });
      navigator.mediaDevices
        .getUserMedia({
          video: { facingMode: { ideal: cameraFacing } },
          audio: false,
        })
        .then(async (stream) => {
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          videoStream = stream;
          const v = document.createElement("video");
          v.srcObject = stream;
          v.muted = true;
          v.playsInline = true;
          v.autoplay = true;
          try {
            await v.play();
          } catch {
            // some browsers reject play() for off-DOM video; the texture
            // still updates from the stream once metadata is loaded.
          }
          videoEl = v;
          const vt = new THREE.VideoTexture(v);
          vt.colorSpace = THREE.SRGBColorSpace;
          vt.minFilter = THREE.LinearFilter;
          vt.magFilter = THREE.LinearFilter;
          material.map = vt;
          material.needsUpdate = true;
          texture = vt;
        })
        .catch((err) => {
          console.error("[wavefield] camera access denied:", err);
          // Quietly fall back to grayscale; user can re-tap if they change
          // their mind. Revert via state so the UI stays in sync.
          if (!cancelled) setMaterialMode("grayscale");
        });
    } else {
      // grayscale (default)
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness: 0.6,
        metalness: 0.05,
        flatShading: false,
      });
    }

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
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.enablePan = false;

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

    // ─── raycaster pick ─────────────────────────────────────────────
    // Imperative picker — React handler outside this effect calls
    // pickRef.current(cssX, cssY) to map a tap to a (band, row).
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const tmpProbeVec = new THREE.Vector3();
    pickRef.current = (cssX, cssY) => {
      const rect = container.getBoundingClientRect();
      ndc.x = (cssX / rect.width) * 2 - 1;
      ndc.y = -((cssY / rect.height) * 2 - 1);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length === 0) return null;
      const uv = hits[0].uv;
      if (!uv) return null;
      // PlaneGeometry UVs: u = 0 (left edge) → 1 (right edge).
      // After rotateX(-π/2), u still maps left/right (band axis).
      // v = 0 (back of plane) → 1 (front, +Z, newest data).
      const band = Math.min(BANDS - 1, Math.max(0, Math.floor(uv.x * BANDS)));
      const row = Math.min(
        ROWS - 1,
        Math.max(0, Math.floor((1 - uv.y) * ROWS)),
      );
      // Frequency: use the log-band layout's centre for this band.
      const freqHz = layout.centers[band];
      return { band, row, freqHz };
    };

    // ─── data + animation ───────────────────────────────────────────
    const freq = new Float32Array(fftSize / 2);
    const bandDb = new Float32Array(BANDS);
    const smoothed = new Float32Array(BANDS * ROWS);
    const tmpRow = new Float32Array(BANDS * ROWS);

    const sampleIntervalMs = 1000 / SAMPLE_HZ;
    let acc = 0;
    let last = performance.now();
    let raf = 0;

    const writeHeightsToMesh = () => {
      // 5-tap separable Gaussian (see earlier comment).
      for (let r = 0; r < ROWS; r++) {
        const base = r * BANDS;
        for (let c = 0; c < BANDS; c++) {
          const c0 = c >= 2 ? c - 2 : 0;
          const c1 = c >= 1 ? c - 1 : 0;
          const c3 = c <= BANDS - 2 ? c + 1 : BANDS - 1;
          const c4 = c <= BANDS - 3 ? c + 2 : BANDS - 1;
          tmpRow[base + c] =
            (heights[base + c0] +
              heights[base + c1] * 4 +
              heights[base + c] * 6 +
              heights[base + c3] * 4 +
              heights[base + c4]) /
            16;
        }
      }
      for (let r = 0; r < ROWS; r++) {
        const r0 = r >= 2 ? r - 2 : 0;
        const r1 = r >= 1 ? r - 1 : 0;
        const r3 = r <= ROWS - 2 ? r + 1 : ROWS - 1;
        const r4 = r <= ROWS - 3 ? r + 2 : ROWS - 1;
        for (let c = 0; c < BANDS; c++) {
          smoothed[r * BANDS + c] =
            (tmpRow[r0 * BANDS + c] +
              tmpRow[r1 * BANDS + c] * 4 +
              tmpRow[r * BANDS + c] * 6 +
              tmpRow[r3 * BANDS + c] * 4 +
              tmpRow[r4 * BANDS + c]) /
            16;
        }
      }

      const arr = positionAttr.array as Float32Array;
      const span = highGrey - lowGrey;
      const writeColors = materialMode === "grayscale";
      for (let k = 0; k < BANDS * ROWS; k++) {
        const h = smoothed[k];
        arr[k * 3 + 1] = h;
        if (writeColors) {
          const t = Math.min(1, Math.max(0, h / MAX_HEIGHT));
          const g = lowGrey + span * t;
          colorArr[k * 3] = g;
          colorArr[k * 3 + 1] = g;
          colorArr[k * 3 + 2] = g;
        }
      }
      positionAttr.needsUpdate = true;
      if (writeColors) colorAttr.needsUpdate = true;
      geometry.computeVertexNormals();
    };

    // First render: project current heightmap (preserved across remounts).
    writeHeightsToMesh();

    const tick = (now: number) => {
      acc += now - last;
      last = now;

      let didShift = false;
      while (acc >= sampleIntervalMs) {
        acc -= sampleIntervalMs;
        analyser.getFloatFrequencyData(freq);
        aggregateToBands(freq, weights, layout, bandDb);
        heights.copyWithin(BANDS, 0, (ROWS - 1) * BANDS);
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

      if (didShift) writeHeightsToMesh();

      // Live-update probe: SPL number, AND pin the dot to the picked
      // vertex's current world position projected back to screen pixels.
      const cell = probeCellRef.current;
      if (cell && probeDbRef.current) {
        const h = heights[cell.row * BANDS + cell.band];
        const t = h / MAX_HEIGHT;
        const v = FLOOR_DB + t * (TOP_DB - FLOOR_DB);
        probeDbRef.current.textContent = Number.isFinite(v)
          ? `${v.toFixed(1)} dB SPL`
          : "— dB SPL";

        if (probePinRef.current) {
          // PlaneGeometry vertex layout: idx = row * BANDS + band.
          const idx = cell.row * BANDS + cell.band;
          const i3 = idx * 3;
          const arr = positionAttr.array as Float32Array;
          tmpProbeVec.set(arr[i3], arr[i3 + 1], arr[i3 + 2]);
          tmpProbeVec.project(camera);
          const rect = container.getBoundingClientRect();
          const cssX = ((tmpProbeVec.x + 1) * 0.5) * rect.width;
          const cssY = (1 - (tmpProbeVec.y + 1) * 0.5) * rect.height;
          probePinRef.current.style.left = `${cssX}px`;
          probePinRef.current.style.top = `${cssY}px`;
          // Hide if behind the camera or way off-screen.
          probePinRef.current.style.visibility =
            tmpProbeVec.z > 1 || tmpProbeVec.z < -1
              ? "hidden"
              : "visible";
        }
      }

      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      pickRef.current = null;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      geometry.dispose();
      material.dispose();
      texture?.dispose();
      if (videoEl) {
        try {
          videoEl.pause();
        } catch {
          // ignore
        }
        videoEl.srcObject = null;
      }
      videoStream?.getTracks().forEach((t) => t.stop());
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [
    analyser,
    fftSize,
    layout,
    weights,
    theme,
    materialMode,
    textureUrl,
    cameraFacing,
  ]);

  // Tap vs drag: a tap pins the probe at the hit point; a drag (movement
  // > 6 CSS px while the pointer is down) is for OrbitControls rotation
  // and must NOT re-pin or clear the probe. We only commit on pointerup
  // when no movement was detected.
  const dragStateRef = useRef<{
    x: number;
    y: number;
    pointerId: number;
    isDrag: boolean;
  } | null>(null);

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Only track presses on the WebGL canvas — leave material picker,
    // close button, etc. to their own handlers.
    const target = e.target as HTMLElement;
    if (target.tagName !== "CANVAS") return;
    dragStateRef.current = {
      x: e.clientX,
      y: e.clientY,
      pointerId: e.pointerId,
      isDrag: false,
    };
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ds = dragStateRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;
    const dx = e.clientX - ds.x;
    const dy = e.clientY - ds.y;
    if (dx * dx + dy * dy > 36) ds.isDrag = true;
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ds = dragStateRef.current;
    dragStateRef.current = null;
    if (!ds || ds.pointerId !== e.pointerId) return;
    if (ds.isDrag) return; // camera rotated, leave probe alone
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pick = pickRef.current?.(x, y);
    if (!pick) {
      setProbe(null);
      probeCellRef.current = null;
      return;
    }
    probeCellRef.current = { band: pick.band, row: pick.row };
    setProbe({ cssX: x, cssY: y, freqHz: pick.freqHz, bandIndex: pick.band });
  };

  return (
    <div
      className="spectrum wavefield"
      style={{ position: "relative" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      {/* Material picker — three circular swatches in the top-right. */}
      <div className="material-menu">
        <button
          type="button"
          className={`material-circle grayscale ${materialMode === "grayscale" ? "active" : ""}`}
          onClick={() => setMaterialMode("grayscale")}
          aria-label="Grayscale material"
          title="Grayscale"
        />
        <button
          type="button"
          className={`material-circle chrome ${materialMode === "chrome" ? "active" : ""}`}
          onClick={() => setMaterialMode("chrome")}
          aria-label="Chrome with colourful lights"
          title="Chrome"
        />
        <button
          type="button"
          className={`material-circle texture ${materialMode === "texture" ? "active" : ""}`}
          onClick={handleTextureClick}
          aria-label={textureUrl ? "Change uploaded picture" : "Upload picture for texture"}
          title={textureUrl ? "Change picture" : "Upload picture"}
          style={
            textureUrl ? { backgroundImage: `url(${textureUrl})` } : undefined
          }
        >
          {!textureUrl && (
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="9" cy="10" r="1.6" />
              <path d="M3 17l5-5 4 4 3-3 6 6" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className={`material-circle camera ${materialMode === "camera" ? "active" : ""}`}
          onClick={() => setMaterialMode("camera")}
          aria-label="Live camera texture"
          title="Camera (live)"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <circle cx="12" cy="13" r="3.5" />
          </svg>
        </button>
        {materialMode === "camera" && (
          <div className="camera-facing-toggle" role="group" aria-label="Camera">
            <button
              type="button"
              className={cameraFacing === "user" ? "active" : ""}
              onClick={() => setCameraFacing("user")}
              aria-pressed={cameraFacing === "user"}
            >
              Front
            </button>
            <button
              type="button"
              className={cameraFacing === "environment" ? "active" : ""}
              onClick={() => setCameraFacing("environment")}
              aria-pressed={cameraFacing === "environment"}
            >
              Back
            </button>
          </div>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleTextureChange}
        style={{ display: "none" }}
      />

      <span
        style={{
          position: "absolute",
          top: 6,
          left: 8,
          fontSize: 10,
          letterSpacing: "0.04em",
          opacity: 0.55,
          pointerEvents: "none",
        }}
      >
        130 dB SPL
      </span>
      <span
        style={{
          position: "absolute",
          bottom: 6,
          right: 8,
          fontSize: 10,
          letterSpacing: "0.04em",
          opacity: 0.55,
          pointerEvents: "none",
        }}
      >
        0 dB SPL
      </span>

      {probe && (
        <ProbePin
          data={probe}
          pinRef={probePinRef}
          dbRef={probeDbRef}
          onDismiss={() => {
            setProbe(null);
            probeCellRef.current = null;
          }}
        />
      )}
    </div>
  );
}
