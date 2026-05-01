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
const BANDS = 128;
const ROWS = 96;
const SAMPLE_HZ = 30;

const RADIUS = 1.5;
const MAX_DISPLACEMENT = 0.55; // peak adds 37% of radius outward

type MaterialMode = "grayscale" | "chrome" | "texture" | "camera";

// "Audio Globe": frequency wraps around the equator, time history goes from
// north pole (newest) toward south pole (oldest), amplitude pushes vertices
// outward radially. Same material picker as the flat Mesh view.
export function Globe({
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

  // Probe — same pattern as Wavefield.
  const [probe, setProbe] = useState<ProbeData | null>(null);
  const probeDbRef = useRef<HTMLDivElement>(null);
  const probePinRef = useRef<HTMLDivElement>(null);
  const probeCellRef = useRef<{ band: number; row: number } | null>(null);
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

  // Heightmap persists across remounts (theme / material switch).
  const heightsRef = useRef<Float32Array | null>(null);
  if (!heightsRef.current) {
    heightsRef.current = new Float32Array(BANDS * ROWS);
  }

  const handleTextureClick = () => {
    if (materialMode === "texture" && textureUrl) {
      fileInputRef.current?.click();
    } else if (textureUrl) {
      setMaterialMode("texture");
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleTextureChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
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
    camera.position.set(0, 0.4, 5);
    camera.lookAt(0, 0, 0);

    // ─── lights ─────────────────────────────────────────────────────
    const isChrome = materialMode === "chrome";
    const dirLight = new THREE.DirectionalLight(0xffffff, isChrome ? 0.35 : 1.6);
    dirLight.position.set(3, 6, 4);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, isChrome ? 0.12 : 0.5);
    fillLight.position.set(-4, 3, -2);
    scene.add(fillLight);
    scene.add(new THREE.AmbientLight(0xffffff, isChrome ? 0.08 : 0.45));

    if (isChrome) {
      const lightSpecs: Array<{
        color: number;
        position: [number, number, number];
      }> = [
        { color: 0xff2266, position: [4, 2, 1] },
        { color: 0x00ffaa, position: [-4, 2, 1] },
        { color: 0x3366ff, position: [0, 3, -4] },
        { color: 0xffaa22, position: [0, 3, 4] },
      ];
      for (const spec of lightSpecs) {
        const l = new THREE.PointLight(spec.color, 14, 22, 1.4);
        l.position.set(...spec.position);
        scene.add(l);
      }
    }

    // ─── geometry + material ────────────────────────────────────────
    // widthSegments = BANDS  → BANDS+1 longitude positions (last == first)
    // heightSegments = ROWS-1 → ROWS latitude positions (poles included)
    const geometry = new THREE.SphereGeometry(RADIUS, BANDS, ROWS - 1);
    const positionAttr = geometry.attributes.position as THREE.BufferAttribute;
    const positionArray = positionAttr.array as Float32Array;
    // Save base sphere positions so we can recompute displacements per frame
    // without losing the original.
    const basePositions = new Float32Array(positionArray.length);
    basePositions.set(positionArray);

    const vertCount = positionArray.length / 3;
    const colorArr = new Float32Array(vertCount * 3);
    for (let k = 0; k < vertCount; k++) {
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
        side: THREE.FrontSide,
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
        side: THREE.FrontSide,
        roughness: 0.55,
        metalness: 0.05,
        flatShading: false,
      });
    } else if (materialMode === "camera") {
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: false,
        side: THREE.FrontSide,
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
            // see Wavefield for context
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
          console.error("[globe] camera access denied:", err);
          if (!cancelled) setMaterialMode("grayscale");
        });
    } else {
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        side: THREE.FrontSide,
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
    controls.minDistance = 2.5;
    controls.maxDistance = 12;
    controls.enablePan = false;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.4;

    // Pause auto-rotate while the user interacts; resume after 3 s of idle.
    let autoRotateRestoreTimer: number | null = null;
    const onUserInteract = () => {
      controls.autoRotate = false;
      if (autoRotateRestoreTimer != null) {
        window.clearTimeout(autoRotateRestoreTimer);
      }
      autoRotateRestoreTimer = window.setTimeout(() => {
        controls.autoRotate = true;
      }, 3000);
    };
    controls.addEventListener("start", onUserInteract);

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
      // SphereGeometry UVs: u = 0..1 around the equator (longitude),
      // v = 0 (south pole) → 1 (north pole). Our mapping puts newest at
      // top (north), so v=1 → row 0, v=0 → row ROWS-1.
      const band = Math.min(BANDS - 1, Math.max(0, Math.floor(uv.x * BANDS)));
      const row = Math.min(
        ROWS - 1,
        Math.max(0, Math.floor((1 - uv.y) * ROWS)),
      );
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

    const dispFactor = MAX_DISPLACEMENT / RADIUS;

    const writeHeightsToMesh = () => {
      // Horizontal pass — WRAPS around the longitudinal seam so φ=0 = φ=2π
      // smoothing is continuous (no visible vertical scar on the globe).
      for (let r = 0; r < ROWS; r++) {
        const base = r * BANDS;
        for (let c = 0; c < BANDS; c++) {
          const cm2 = (c - 2 + BANDS) % BANDS;
          const cm1 = (c - 1 + BANDS) % BANDS;
          const cp1 = (c + 1) % BANDS;
          const cp2 = (c + 2) % BANDS;
          tmpRow[base + c] =
            (heights[base + cm2] +
              heights[base + cm1] * 4 +
              heights[base + c] * 6 +
              heights[base + cp1] * 4 +
              heights[base + cp2]) /
            16;
        }
      }
      // Vertical pass — clamps at the poles. Pole singularities are real.
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

      // Write displaced positions: position = base * (1 + height * dispFactor).
      // SphereGeometry vertex layout: index = y*(BANDS+1) + x where y in [0,
      // ROWS-1], x in [0, BANDS]. The seam (x = BANDS) reads from band 0.
      const writeColors = materialMode === "grayscale";
      const span = highGrey - lowGrey;
      const stride = BANDS + 1;
      for (let y = 0; y < ROWS; y++) {
        const rowBase = y * BANDS;
        for (let x = 0; x <= BANDS; x++) {
          const c = x === BANDS ? 0 : x;
          const t = Math.min(1, Math.max(0, smoothed[rowBase + c]));
          const scale = 1 + t * dispFactor;
          const idx = y * stride + x;
          const i3 = idx * 3;
          positionArray[i3] = basePositions[i3] * scale;
          positionArray[i3 + 1] = basePositions[i3 + 1] * scale;
          positionArray[i3 + 2] = basePositions[i3 + 2] * scale;
          if (writeColors) {
            const g = lowGrey + span * t;
            colorArr[i3] = g;
            colorArr[i3 + 1] = g;
            colorArr[i3 + 2] = g;
          }
        }
      }
      positionAttr.needsUpdate = true;
      if (writeColors) colorAttr.needsUpdate = true;
      geometry.computeVertexNormals();
    };

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
          heights[i] = t;
        }
        didShift = true;
      }

      if (didShift) writeHeightsToMesh();

      // Live-update probe SPL + pin the dot to the deformed vertex's
      // projected screen position so it stays glued to the surface as the
      // sphere rotates.
      const cell = probeCellRef.current;
      if (cell && probeDbRef.current) {
        const t = heights[cell.row * BANDS + cell.band];
        const v = FLOOR_DB + t * (TOP_DB - FLOOR_DB);
        probeDbRef.current.textContent = Number.isFinite(v)
          ? `${v.toFixed(1)} dB SPL`
          : "— dB SPL";

        if (probePinRef.current) {
          // SphereGeometry stride = (BANDS + 1). Use band index for the
          // first column copy (vertex at the seam mirrors band 0).
          const stride = BANDS + 1;
          const idx = cell.row * stride + cell.band;
          const i3 = idx * 3;
          tmpProbeVec.set(
            positionArray[i3],
            positionArray[i3 + 1],
            positionArray[i3 + 2],
          );
          // Hide when the surface point is on the FAR side of the sphere
          // (camera vector and surface normal pointing apart).
          const camDir = camera.position.clone().sub(tmpProbeVec).normalize();
          const surfNormal = tmpProbeVec.clone().normalize();
          const facingCamera = camDir.dot(surfNormal) > 0;

          tmpProbeVec.project(camera);
          const rect = container.getBoundingClientRect();
          const cssX = ((tmpProbeVec.x + 1) * 0.5) * rect.width;
          const cssY = (1 - (tmpProbeVec.y + 1) * 0.5) * rect.height;
          probePinRef.current.style.left = `${cssX}px`;
          probePinRef.current.style.top = `${cssY}px`;
          probePinRef.current.style.visibility =
            !facingCamera || tmpProbeVec.z > 1 || tmpProbeVec.z < -1
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
      controls.removeEventListener("start", onUserInteract);
      controls.dispose();
      if (autoRotateRestoreTimer != null) {
        window.clearTimeout(autoRotateRestoreTimer);
      }
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
  }, [analyser, fftSize, layout, weights, theme, materialMode, textureUrl, cameraFacing]);

  // Tap vs drag — same logic as Wavefield. Drag rotates the globe via
  // OrbitControls and must not touch the probe.
  const dragStateRef = useRef<{
    x: number;
    y: number;
    pointerId: number;
    isDrag: boolean;
  } | null>(null);

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
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
    if (ds.isDrag) return;
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
          aria-label={textureUrl ? "Use uploaded texture" : "Upload picture for texture"}
          title={textureUrl ? "Texture" : "Upload picture"}
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
              <circle cx="9" cy="10" r="1.8" />
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
