import { useRef, useMemo, Suspense } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Environment } from "@react-three/drei";
import * as THREE from "three";

// ─── Mathematical Constants ───────────────────────────────────────────────────
const PHI = (1 + Math.sqrt(5)) / 2; // Golden ratio ≈ 1.618
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 137.5°

// ─── Procedural Petal Geometry ────────────────────────────────────────────────
// Each petal is a custom BufferGeometry shaped by a 2D polar rose curve
// r(θ) = a·cos(n·θ), then extruded into 3D and curved via a cubic bezier warp
function buildPetalGeometry(
    length = 1,
    width = 0.55,
    curl = 0.45,
    resolution = 32,
) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];

    const uSegs = resolution;
    const vSegs = Math.floor(resolution / 2);

    for (let j = 0; j <= vSegs; j++) {
        const v = j / vSegs; // 0 (base) → 1 (tip)
        for (let i = 0; i <= uSegs; i++) {
            const u = i / uSegs; // 0 → 1 across width

            // Width envelope: petal narrows at base and tip (sin curve)
            const widthFactor =
                Math.sin(v * Math.PI) *
                width *
                (0.5 + 0.5 * Math.sin(u * Math.PI));

            // Slight side curvature via cosine
            const x = (u - 0.5) * 2 * widthFactor;

            // Forward length – straight along stem direction
            const y = v * length;

            // Z-height: petals cup inward at base, curl back at tips
            // Cubic bezier-like formula for organic shape
            const baseClip = 1 - Math.pow(1 - v, 2);
            const tipCurl = Math.pow(v, 2) * curl;
            const sideCup = Math.pow(Math.abs(u - 0.5) * 2, 1.5) * 0.18;
            const z =
                tipCurl - sideCup * (1 - v) * length * 0.3 + baseClip * 0.04;

            positions.push(x, y, z);
            uvs.push(u, v);

            // Approximate normal via finite difference (calculated below after all positions)
            normals.push(0, 0, 1);
        }
    }

    // Build indices
    for (let j = 0; j < vSegs; j++) {
        for (let i = 0; i < uSegs; i++) {
            const a = j * (uSegs + 1) + i;
            const b = a + uSegs + 1;
            indices.push(a, b, a + 1);
            indices.push(b, b + 1, a + 1);
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
    );
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals(); // Auto-smooth shading
    return geo;
}

// ─── Single Rose Component ────────────────────────────────────────────────────
function Rose({
    position = [0, 0, 0],
    color = "#cc1133",
    scale = 1,
    windPhase = 0,
    windStrength = 1,
}) {
    const groupRef = useRef();
    const stemRef = useRef();
    const headRef = useRef();
    const petalRefs = useRef([]);

    // ── Rose head: Fibonacci spiral petal placement ──────────────────────────
    // Using sunflower/Vogel formula: θ_n = n · GOLDEN_ANGLE, r_n = √n
    // Petals are placed in concentric rings by Fibonacci indexing so no two petals
    // align — exactly how a real rose blooms.
    const petalLayers = useMemo(() => {
        const layers = [];
        const TOTAL_PETALS = 48;

        for (let n = 0; n < TOTAL_PETALS; n++) {
            const t = n / TOTAL_PETALS; // Normalized position 0→1
            const angle = n * GOLDEN_ANGLE;
            // Radial distance: inner petals tighter, outer looser
            const r = Math.sqrt(n / TOTAL_PETALS) * 0.72;

            // Height: petals rise as they move outward (dome shape)
            const heightT = 1 - t;
            const y = heightT * 0.55 + Math.pow(t, 0.5) * -0.15;

            // Size scales with ring position (outer petals larger)
            const petalLength = 0.28 + t * 0.55;
            const petalWidth = 0.5 + t * 0.45;
            const petalCurl = 0.15 + t * 0.55;

            // Tilt: inner petals stand tall, outer ones flare out
            const tiltX = -Math.PI * 0.08 + t * Math.PI * 0.52;

            // Color gradient: deep wine at center → bright crimson at edges
            const hue = THREE.MathUtils.lerp(0.95, 0.03, t); // 342° (dark rose) → 11° (warm red)
            const sat = THREE.MathUtils.lerp(0.7, 1.0, t);
            const lit = THREE.MathUtils.lerp(0.22, 0.48, t);
            const petalColor = new THREE.Color().setHSL(hue, sat, lit);

            layers.push({
                angle,
                r,
                y,
                tiltX,
                petalLength,
                petalWidth,
                petalCurl,
                petalColor,
                t,
                index: n,
            });
        }
        return layers;
    }, []);

    // ── Stem: CatmullRom cubic spline → TubeGeometry ─────────────────────────
    const { stemGeo, stemPoints } = useMemo(() => {
        const pts = [
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0.04, 0.6, 0.02),
            new THREE.Vector3(-0.06, 1.2, -0.03),
            new THREE.Vector3(0.03, 1.8, 0.04),
            new THREE.Vector3(0, 2.4, 0),
        ];
        const curve = new THREE.CatmullRomCurve3(pts);
        const geo = new THREE.TubeGeometry(curve, 40, 0.028, 8, false);
        return { stemGeo: geo, stemPoints: pts };
    }, []);

    // ── Leaf geometry: custom jagged organic shape ────────────────────────────
    const leafGeo = useMemo(() => {
        const shape = new THREE.Shape();
        // Main leaf outline using bezier curves + serrated edge approximation
        shape.moveTo(0, 0);
        // Left serrated edge going up
        const serrations = 7;
        for (let i = 0; i <= serrations; i++) {
            const t = i / serrations;
            const lx = -Math.sin(t * Math.PI) * 0.32;
            const ly = t * 0.75;
            const jag = i % 2 === 0 ? -0.035 : 0.025;
            if (i === 0) shape.lineTo(lx, ly);
            else shape.quadraticCurveTo(lx + jag * 0.5, ly - 0.05, lx, ly);
        }
        // Tip
        shape.quadraticCurveTo(0, 0.82, 0, 0.8);
        // Right serrated edge going down
        for (let i = serrations; i >= 0; i--) {
            const t = i / serrations;
            const rx = Math.sin(t * Math.PI) * 0.32;
            const ry = t * 0.75;
            const jag = i % 2 === 0 ? 0.035 : -0.025;
            shape.quadraticCurveTo(rx + jag * 0.5, ry + 0.05, rx, ry);
        }
        shape.closePath();

        const extrudeSettings = {
            depth: 0.008,
            bevelEnabled: true,
            bevelThickness: 0.003,
            bevelSize: 0.006,
            bevelSegments: 2,
        };
        return new THREE.ExtrudeGeometry(shape, extrudeSettings);
    }, []);

    // ── Petal geometry instances (reused across all petals) ───────────────────
    const petalGeoSmall = useMemo(
        () => buildPetalGeometry(0.42, 0.5, 0.2, 24),
        [],
    );
    const petalGeoMedium = useMemo(
        () => buildPetalGeometry(0.62, 0.55, 0.38, 28),
        [],
    );
    const petalGeoLarge = useMemo(
        () => buildPetalGeometry(0.82, 0.58, 0.55, 32),
        [],
    );

    // ── Animation: Layered sine wind simulation ───────────────────────────────
    // We combine multiple sine waves at different frequencies/amplitudes to mimic
    // natural turbulence. The stem acts as a weighted pendulum — base anchored,
    // tip amplifies displacement.
    useFrame(({ clock }) => {
        const t = clock.getElapsedTime();

        if (groupRef.current) {
            // Primary slow sway (main wind gust)
            const swayX = Math.sin(t * 0.7 + windPhase) * 0.06 * windStrength;
            const swayZ =
                Math.cos(t * 0.5 + windPhase * 1.3) * 0.04 * windStrength;
            // Secondary faster micro-turbulence
            const gustX =
                Math.sin(t * 2.1 + windPhase * 0.7) * 0.018 * windStrength;
            const gustZ =
                Math.cos(t * 1.8 + windPhase * 1.1) * 0.012 * windStrength;

            groupRef.current.rotation.x = swayX + gustX;
            groupRef.current.rotation.z = swayZ + gustZ;
        }

        // Rose head bobs with slight extra amplitude (heavier, lag behind stem)
        if (headRef.current) {
            const lag =
                Math.sin(t * 0.7 + windPhase + 0.3) * 0.04 * windStrength;
            const microFlutter =
                Math.sin(t * 4.3 + windPhase) * 0.008 * windStrength;
            headRef.current.rotation.x = lag + microFlutter;
            headRef.current.rotation.z =
                Math.cos(t * 0.6 + windPhase) * 0.03 * windStrength;
        }

        // Micro-flutter on individual petals (outer ones more than inner)
        petalRefs.current.forEach((ref, i) => {
            if (ref && petalLayers[i]) {
                const layer = petalLayers[i];
                const flutter =
                    Math.sin(
                        t * (3.5 + layer.t * 2) + windPhase + layer.angle,
                    ) *
                    0.012 *
                    layer.t *
                    windStrength;
                ref.rotation.x = flutter;
            }
        });
    });

    // ── Material factory ───────────────────────────────────────────────────────
    const stemMat = useMemo(
        () =>
            new THREE.MeshPhysicalMaterial({
                color: "#2d5a1b",
                roughness: 0.75,
                metalness: 0.0,
                clearcoat: 0.15,
                clearcoatRoughness: 0.6,
            }),
        [],
    );

    const leafMat = useMemo(
        () =>
            new THREE.MeshPhysicalMaterial({
                color: "#2e6b1a",
                roughness: 0.7,
                metalness: 0.0,
                side: THREE.DoubleSide,
                clearcoat: 0.3,
                clearcoatRoughness: 0.4,
            }),
        [],
    );

    // Per-petal materials (memoized as array)
    const petalMaterials = useMemo(
        () =>
            petalLayers.map(
                ({ petalColor }) =>
                    new THREE.MeshPhysicalMaterial({
                        color: petalColor,
                        roughness: 0.35,
                        metalness: 0.0,
                        clearcoat: 0.6,
                        clearcoatRoughness: 0.2,
                        sheen: 0.4,
                        sheenRoughness: 0.5,
                        sheenColor: new THREE.Color("#ff6688"),
                        side: THREE.DoubleSide,
                        thickness: 0.4, // For SSS approximation
                        transmission: 0.05, // Slight translucency at petal edges
                        transparent: false,
                    }),
            ),
        [petalLayers],
    );

    return (
        <group ref={groupRef} position={position} scale={scale}>
            {/* ── Stem ── */}
            <mesh
                geometry={stemGeo}
                material={stemMat}
                ref={stemRef}
                castShadow
            />

            {/* ── Leaves (two leaves at different heights on the stem) ── */}
            {[
                {
                    pos: [0.01, 0.65, 0],
                    rot: [Math.PI * 0.08, 0.3, Math.PI * 0.55],
                    sc: 0.55,
                },
                {
                    pos: [-0.02, 1.1, 0],
                    rot: [Math.PI * 0.06, -0.4, -Math.PI * 0.5],
                    sc: 0.5,
                },
                {
                    pos: [0.02, 1.55, 0],
                    rot: [Math.PI * 0.1, 0.5, Math.PI * 0.45],
                    sc: 0.42,
                },
            ].map((leaf, i) => (
                <mesh
                    key={i}
                    geometry={leafGeo}
                    material={leafMat}
                    position={leaf.pos}
                    rotation={leaf.rot}
                    scale={leaf.sc}
                    castShadow
                />
            ))}

            {/* ── Rose head group (at top of stem) ── */}
            <group ref={headRef} position={[0, 2.42, 0]}>
                {petalLayers.map((layer, i) => {
                    const geo =
                        layer.t < 0.3
                            ? petalGeoSmall
                            : layer.t < 0.65
                              ? petalGeoMedium
                              : petalGeoLarge;
                    return (
                        <group
                            key={i}
                            rotation={[0, layer.angle, 0]}
                            position={[
                                layer.r * Math.cos(layer.angle) * 0,
                                0,
                                0,
                            ]}
                        >
                            <group
                                position={[layer.r * 0.9, layer.y, 0]}
                                rotation={[-layer.tiltX, 0, 0]}
                            >
                                <mesh
                                    ref={(el) => (petalRefs.current[i] = el)}
                                    geometry={geo}
                                    material={petalMaterials[i]}
                                    // Center the petal geometry at its base
                                    position={[-0.0, -0.04, 0]}
                                    castShadow
                                    receiveShadow
                                />
                            </group>
                        </group>
                    );
                })}

                {/* Receptacle / sepal base: small green sphere */}
                <mesh position={[0, -0.12, 0]} castShadow>
                    <sphereGeometry args={[0.14, 16, 12]} />
                    <meshPhysicalMaterial color="#2a5c18" roughness={0.8} />
                </mesh>
            </group>
        </group>
    );
}

// ─── Ground Plane ─────────────────────────────────────────────────────────────
function Garden() {
    return (
        <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, 0, 0]}
            receiveShadow
        >
            <planeGeometry args={[30, 30, 40, 40]} />
            <meshPhysicalMaterial
                color="#0a1a05"
                roughness={0.95}
                metalness={0.0}
            />
        </mesh>
    );
}

// ─── Particle Fireflies ───────────────────────────────────────────────────────
function Fireflies({ count = 80 }) {
    const ref = useRef();

    const { positions, phases } = useMemo(() => {
        const pos = new Float32Array(count * 3);
        const ph = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            pos[i * 3 + 0] = (Math.random() - 0.5) * 14;
            pos[i * 3 + 1] = Math.random() * 4 + 0.3;
            pos[i * 3 + 2] = (Math.random() - 0.5) * 14;
            ph[i] = Math.random() * Math.PI * 2;
        }
        return { positions: pos, phases: ph };
    }, [count]);

    useFrame(({ clock }) => {
        if (!ref.current) return;
        const t = clock.getElapsedTime();
        const pos = ref.current.geometry.attributes.position.array;
        for (let i = 0; i < count; i++) {
            pos[i * 3 + 1] =
                positions[i * 3 + 1] + Math.sin(t * 0.8 + phases[i]) * 0.3;
            pos[i * 3 + 0] =
                positions[i * 3 + 0] +
                Math.sin(t * 0.4 + phases[i] * 1.3) * 0.15;
        }
        ref.current.geometry.attributes.position.needsUpdate = true;
    });

    return (
        <points ref={ref}>
            <bufferGeometry>
                <bufferAttribute
                    attach="attributes-position"
                    args={[positions, 3]}
                />
            </bufferGeometry>
            <pointsMaterial
                color="#ffffaa"
                size={0.04}
                transparent
                opacity={0.85}
                sizeAttenuation
                blending={THREE.AdditiveBlending}
                depthWrite={false}
            />
        </points>
    );
}

// ─── Scene Lighting ───────────────────────────────────────────────────────────
function Lighting() {
    const moonRef = useRef();

    useFrame(({ clock }) => {
        if (moonRef.current) {
            // Very subtle moonlight shimmer
            const t = clock.getElapsedTime();
            moonRef.current.intensity = 1.1 + Math.sin(t * 0.3) * 0.05;
        }
    });

    return (
        <>
            {/* Deep night ambient */}
            <ambientLight intensity={0.18} color="#1a2040" />

            {/* Moonlight — cool blue-white from upper right */}
            <directionalLight
                ref={moonRef}
                position={[6, 10, 4]}
                intensity={1.1}
                color="#c8d8ff"
                castShadow
                shadow-mapSize={[2048, 2048]}
                shadow-camera-far={30}
                shadow-camera-left={-10}
                shadow-camera-right={10}
                shadow-camera-top={10}
                shadow-camera-bottom={-10}
                shadow-bias={-0.001}
            />

            {/* Warm golden fill — simulates distant garden lantern */}
            <pointLight
                position={[-3, 2, 2]}
                intensity={0.6}
                color="#ff9944"
                distance={12}
                decay={2}
            />

            {/* Cool rim light from behind for silhouette drama */}
            <directionalLight
                position={[-4, 5, -6]}
                intensity={0.35}
                color="#4488ff"
            />

            {/* Ethereal inner glow near roses */}
            <pointLight
                position={[0, 3.2, 0]}
                intensity={0.45}
                color="#ff2244"
                distance={4}
                decay={2}
            />
            <pointLight
                position={[2.5, 2.8, 1.5]}
                intensity={0.3}
                color="#ff3355"
                distance={3.5}
                decay={2}
            />
            <pointLight
                position={[-2.5, 2.6, -1]}
                intensity={0.3}
                color="#cc1133"
                distance={3}
                decay={2}
            />
        </>
    );
}

// ─── Fog Particles (atmospheric depth) ────────────────────────────────────────
function MistParticles({ count = 200 }) {
    const ref = useRef();
    const { positions, phases } = useMemo(() => {
        const pos = new Float32Array(count * 3);
        const ph = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            pos[i * 3 + 0] = (Math.random() - 0.5) * 20;
            pos[i * 3 + 1] = Math.random() * 2.5;
            pos[i * 3 + 2] = (Math.random() - 0.5) * 20;
            ph[i] = Math.random() * Math.PI * 2;
        }
        return { positions: pos, phases: ph };
    }, [count]);

    useFrame(({ clock }) => {
        if (!ref.current) return;
        const t = clock.getElapsedTime() * 0.12;
        const pos = ref.current.geometry.attributes.position.array;
        for (let i = 0; i < count; i++) {
            pos[i * 3 + 0] =
                positions[i * 3 + 0] + Math.sin(t + phases[i]) * 0.8;
            pos[i * 3 + 1] =
                positions[i * 3 + 1] + Math.sin(t * 1.7 + phases[i]) * 0.1;
        }
        ref.current.geometry.attributes.position.needsUpdate = true;
    });

    return (
        <points ref={ref}>
            <bufferGeometry>
                <bufferAttribute
                    attach="attributes-position"
                    args={[positions, 3]}
                />
            </bufferGeometry>
            <pointsMaterial
                color="#8899cc"
                size={0.35}
                transparent
                opacity={0.06}
                sizeAttenuation
                blending={THREE.AdditiveBlending}
                depthWrite={false}
            />
        </points>
    );
}

// ─── Full Scene ───────────────────────────────────────────────────────────────
// Rose positions arranged in a slight arc, varying heights and scales
const ROSE_CONFIGS = [
    {
        position: [0, 0, 0],
        color: "#cc1122",
        scale: 1.0,
        windPhase: 0,
        windStrength: 1.0,
    },
    {
        position: [2.2, 0, -0.5],
        color: "#bb0011",
        scale: 0.88,
        windPhase: 1.1,
        windStrength: 1.1,
    },
    {
        position: [-2.0, 0, -0.4],
        color: "#dd1133",
        scale: 0.92,
        windPhase: 2.3,
        windStrength: 0.9,
    },
    {
        position: [4.0, 0, -1.2],
        color: "#aa0020",
        scale: 0.75,
        windPhase: 0.7,
        windStrength: 1.2,
    },
    {
        position: [-3.8, 0, -0.8],
        color: "#c8001e",
        scale: 0.8,
        windPhase: 1.8,
        windStrength: 1.05,
    },
    {
        position: [1.0, 0, 1.8],
        color: "#e01030",
        scale: 0.7,
        windPhase: 3.1,
        windStrength: 0.85,
    },
    {
        position: [-1.2, 0, 1.5],
        color: "#cc0028",
        scale: 0.72,
        windPhase: 0.4,
        windStrength: 1.15,
    },
];

function Scene() {
    return (
        <>
            <Lighting />
            <Garden />
            <Fireflies count={90} />
            <MistParticles count={180} />
            {ROSE_CONFIGS.map((cfg, i) => (
                <Rose key={i} {...cfg} />
            ))}
        </>
    );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
    return (
        <div
            style={{
                width: "100vw",
                height: "100vh",
                background: "#000408",
                overflow: "hidden",
                fontFamily: "Georgia, serif",
            }}
        >
            {/* Overlay title */}
            <div
                style={{
                    position: "absolute",
                    top: "28px",
                    left: "50%",
                    transform: "translateX(-50%)",
                    zIndex: 10,
                    textAlign: "center",
                    pointerEvents: "none",
                }}
            >
                <div
                    style={{
                        fontSize: "11px",
                        letterSpacing: "0.35em",
                        color: "#cc4455",
                        textTransform: "uppercase",
                        marginBottom: "6px",
                        opacity: 0.9,
                    }}
                >
                    Midnight Garden
                </div>
                <div
                    style={{
                        fontSize: "26px",
                        color: "#fff0f2",
                        fontWeight: "300",
                        letterSpacing: "0.08em",
                        textShadow: "0 0 30px rgba(200,20,50,0.5)",
                    }}
                >
                    This garden for you my WIFE
                </div>
            </div>

            {/* Hint */}
            <div
                style={{
                    position: "absolute",
                    bottom: "24px",
                    left: "50%",
                    transform: "translateX(-50%)",
                    zIndex: 10,
                    fontSize: "10px",
                    letterSpacing: "0.22em",
                    color: "#664455",
                    textTransform: "uppercase",
                    pointerEvents: "none",
                }}
            >
                Drag to orbit · Scroll to zoom
            </div>

            {/* Corner vignette */}
            <div
                style={{
                    position: "absolute",
                    inset: 0,
                    background:
                        "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.75) 100%)",
                    pointerEvents: "none",
                    zIndex: 5,
                }}
            />

            <Canvas
                shadows
                camera={{ position: [0, 3.5, 8], fov: 52, near: 0.1, far: 120 }}
                gl={{
                    antialias: true,
                    toneMapping: THREE.ACESFilmicToneMapping,
                    toneMappingExposure: 0.85,
                    outputColorSpace: THREE.SRGBColorSpace,
                }}
                style={{ position: "absolute", inset: 0 }}
            >
                {/* Atmospheric fog */}
                <fog attach="fog" args={["#050810", 10, 38]} />

                <Suspense fallback={null}>
                    <Scene />
                </Suspense>

                <OrbitControls
                    enableDamping
                    dampingFactor={0.06}
                    minDistance={3}
                    maxDistance={18}
                    maxPolarAngle={Math.PI * 0.48}
                    target={[0, 2, 0]}
                />
            </Canvas>
        </div>
    );
}
