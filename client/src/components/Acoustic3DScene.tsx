import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Eye, RotateCcw, Volume2, Mic, Maximize2, Sparkles, Sliders } from "lucide-react";

interface Acoustic3DSceneProps {
  active: boolean;
  bit: number;
  frequency: number;
  audioLevel: number;
  mode: "transmitter" | "receiver";
  noise?: number;
  statusText?: string;
}

export default function Acoustic3DScene({
  active,
  bit,
  frequency,
  audioLevel,
  mode,
  noise = 0,
  statusText = "IDLE",
}: Acoustic3DSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cameraView, setCameraView] = useState<"orbit" | "top" | "tx" | "rx">("orbit");
  const [showParticles, setShowParticles] = useState(true);
  const [showWavefronts, setShowWavefronts] = useState(true);

  // Keep live references so Three.js render loop reads latest props without re-instantiating scene
  const propsRef = useRef({ active, bit, frequency, audioLevel, mode, noise });
  useEffect(() => {
    propsRef.current = { active, bit, frequency, audioLevel, mode, noise };
  }, [active, bit, frequency, audioLevel, mode, noise]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 1. Setup Scene, Camera, Renderer
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 450;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x141413);
    scene.fog = new THREE.FogExp2(0x141413, 0.035);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 4.5, 12);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    container.appendChild(renderer.domElement);

    // 2. Lighting
    const ambientLight = new THREE.AmbientLight(0x282622, 2.2);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xf5efe6, 1.8);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    const txLight = new THREE.PointLight(0xd97757, 3.5, 8);
    txLight.position.set(-4.5, 1.2, 0);
    scene.add(txLight);

    const rxLight = new THREE.PointLight(0x10b981, 3.5, 8);
    rxLight.position.set(4.5, 1.2, 0);
    scene.add(rxLight);

    // 3. Grid & Environment Bench
    const gridHelper = new THREE.GridHelper(24, 32, 0x3d3934, 0x1f1e1b);
    gridHelper.position.y = -1.2;
    scene.add(gridHelper);

    // 4. Create 3D Transmitter Model (Laptop on Left: X = -4.5)
    const txGroup = new THREE.Group();
    txGroup.position.set(-4.5, -0.6, 0);

    // Laptop Base
    const baseGeo = new THREE.BoxGeometry(2.4, 0.1, 1.8);
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x111927, roughness: 0.3, metalness: 0.8 });
    const baseMesh = new THREE.Mesh(baseGeo, darkMat);
    txGroup.add(baseMesh);

    // Laptop Screen
    const screenGeo = new THREE.BoxGeometry(2.4, 1.6, 0.08);
    const screenMesh = new THREE.Mesh(screenGeo, darkMat);
    screenMesh.position.set(0, 0.85, -0.85);
    screenMesh.rotation.x = -Math.PI / 16;
    txGroup.add(screenMesh);

    // Glowing Display Area
    const displayGeo = new THREE.PlaneGeometry(2.2, 1.4);
    const txDisplayMat = new THREE.MeshBasicMaterial({ color: 0x003b5c });
    const displayMesh = new THREE.Mesh(displayGeo, txDisplayMat);
    displayMesh.position.set(0, 0.86, -0.8);
    displayMesh.rotation.x = -Math.PI / 16;
    txGroup.add(displayMesh);

    // Speaker Transducer Ring (Emitting Sound)
    const speakerRingGeo = new THREE.RingGeometry(0.18, 0.35, 32);
    const speakerRingMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, side: THREE.DoubleSide });
    const speakerRing = new THREE.Mesh(speakerRingGeo, speakerRingMat);
    speakerRing.position.set(0.8, 0.06, 0.3);
    speakerRing.rotation.x = -Math.PI / 2;
    txGroup.add(speakerRing);

    scene.add(txGroup);

    // 5. Create 3D Receiver Model (Smartphone on Right: X = 4.5)
    const rxGroup = new THREE.Group();
    rxGroup.position.set(4.5, -0.6, 0);

    // Phone Body
    const phoneGeo = new THREE.BoxGeometry(1.0, 1.9, 0.09);
    const phoneMesh = new THREE.Mesh(phoneGeo, darkMat);
    phoneMesh.rotation.y = -Math.PI / 8;
    phoneMesh.rotation.x = -Math.PI / 14;
    phoneMesh.position.y = 0.5;
    rxGroup.add(phoneMesh);

    // Phone Screen
    const phoneScreenGeo = new THREE.PlaneGeometry(0.92, 1.76);
    const rxDisplayMat = new THREE.MeshBasicMaterial({ color: 0x04281f });
    const phoneScreen = new THREE.Mesh(phoneScreenGeo, rxDisplayMat);
    phoneScreen.position.set(0, 0.5, 0.05);
    phoneScreen.rotation.y = -Math.PI / 8;
    phoneScreen.rotation.x = -Math.PI / 14;
    rxGroup.add(phoneScreen);

    // Phone Mic Aperture
    const micRingGeo = new THREE.RingGeometry(0.06, 0.14, 24);
    const micRingMat = new THREE.MeshBasicMaterial({ color: 0x10b981, side: THREE.DoubleSide });
    const micRing = new THREE.Mesh(micRingGeo, micRingMat);
    micRing.position.set(-0.35, -0.35, 0.06);
    micRing.rotation.y = -Math.PI / 8;
    micRing.rotation.x = -Math.PI / 14;
    rxGroup.add(micRing);

    scene.add(rxGroup);

    // 6. Central 3D Acoustic Wave Ribbon (Connecting TX to RX)
    const curvePointsCount = 120;
    const curveGeo = new THREE.BufferGeometry();
    const curvePositions = new Float32Array(curvePointsCount * 3);
    const curveColors = new Float32Array(curvePointsCount * 3);
    curveGeo.setAttribute("position", new THREE.BufferAttribute(curvePositions, 3));
    curveGeo.setAttribute("color", new THREE.BufferAttribute(curveColors, 3));

    const curveMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      linewidth: 3,
      transparent: true,
      opacity: 0.9,
    });
    const waveLine = new THREE.Line(curveGeo, curveMat);
    scene.add(waveLine);

    // 7. Dynamic Acoustic Air Particles (Air molecules undergoing compression & rarefaction)
    const particleCount = 750;
    const particleGeo = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(particleCount * 3);
    const particleBasePositions = new Float32Array(particleCount * 3);
    const particleColors = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
      // Scatter particles evenly inside a cylindrical corridor between TX (x = -4) and RX (x = 4)
      const t = i / particleCount;
      const x = -4.0 + t * 8.0;
      const radius = 0.2 + Math.random() * 1.6;
      const angle = Math.random() * Math.PI * 2;
      const y = Math.sin(angle) * radius * 0.7 + 0.2;
      const z = Math.cos(angle) * radius;

      particlePositions[i * 3] = x;
      particlePositions[i * 3 + 1] = y;
      particlePositions[i * 3 + 2] = z;

      particleBasePositions[i * 3] = x;
      particleBasePositions[i * 3 + 1] = y;
      particleBasePositions[i * 3 + 2] = z;

      // Base air particle color (cool cyan-blue)
      particleColors[i * 3] = 0.2;
      particleColors[i * 3 + 1] = 0.6;
      particleColors[i * 3 + 2] = 0.9;
    }

    particleGeo.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));
    particleGeo.setAttribute("color", new THREE.BufferAttribute(particleColors, 3));

    const particleMat = new THREE.PointsMaterial({
      size: 0.08,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
    });
    const particleSystem = new THREE.Points(particleGeo, particleMat);
    scene.add(particleSystem);

    // 8. Propagating Wavefront Rings (Spherical sound wavefronts travelling from TX to RX)
    const ringCount = 8;
    const waveRings: THREE.Mesh[] = [];
    const ringGeo = new THREE.TorusGeometry(1, 0.025, 16, 64);

    for (let i = 0; i < ringCount; i++) {
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x00f0ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
      });
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.rotation.y = Math.PI / 2;
      ringMesh.position.x = -4.0;
      ringMesh.position.y = 0.2;
      scene.add(ringMesh);
      waveRings.push(ringMesh);
    }

    // 9. Interactive Mouse Drag for 3D Orbit
    let isDragging = false;
    let prevMouseX = 0;
    let prevMouseY = 0;
    let rotY = 0;
    let rotX = 0.35;
    let cameraDistance = 11.5;

    const onMouseDown = (e: MouseEvent) => {
      isDragging = true;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const deltaX = e.clientX - prevMouseX;
      const deltaY = e.clientY - prevMouseY;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;

      rotY += deltaX * 0.008;
      rotX = Math.max(0.05, Math.min(Math.PI / 2.2, rotX - deltaY * 0.008));
    };

    const onMouseUp = () => {
      isDragging = false;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cameraDistance = Math.max(5, Math.min(20, cameraDistance + e.deltaY * 0.01));
    };

    // Touch support for mobile devices
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        isDragging = true;
        prevMouseX = e.touches[0].clientX;
        prevMouseY = e.touches[0].clientY;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isDragging || e.touches.length !== 1) return;
      const deltaX = e.touches[0].clientX - prevMouseX;
      const deltaY = e.touches[0].clientY - prevMouseY;
      prevMouseX = e.touches[0].clientX;
      prevMouseY = e.touches[0].clientY;

      rotY += deltaX * 0.008;
      rotX = Math.max(0.05, Math.min(Math.PI / 2.2, rotX - deltaY * 0.008));
    };

    const onTouchEnd = () => {
      isDragging = false;
    };

    const domEl = renderer.domElement;
    domEl.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    domEl.addEventListener("wheel", onWheel, { passive: false });
    domEl.addEventListener("touchstart", onTouchStart, { passive: true });
    domEl.addEventListener("touchmove", onTouchMove, { passive: true });
    domEl.addEventListener("touchend", onTouchEnd);

    // 10. Animation Render Loop
    let animId: number;
    let clock = new THREE.Clock();

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const elapsed = clock.getElapsedTime();
      const { active: isAct, bit: curBit, frequency: freq, audioLevel: level, noise: curNoise } = propsRef.current;

      // Camera positioning according to view mode
      const targetCamDistance = cameraDistance;
      const cx = Math.sin(rotY) * Math.cos(rotX) * targetCamDistance;
      const cy = Math.sin(rotX) * targetCamDistance;
      const cz = Math.cos(rotY) * Math.cos(rotX) * targetCamDistance;
      camera.position.set(cx, cy, cz);
      camera.lookAt(0, 0, 0);

      // Active modulation color
      const isBit1 = curBit === 1;
      const primaryColor = isBit1 ? new THREE.Color(0x10b981) : new THREE.Color(0x00f0ff);
      const glowIntensity = isAct ? 1.0 + Math.max(0.2, level) * 2.5 : 0.4;

      // Animate Speaker & Microphone glow
      speakerRing.scale.setScalar(isAct ? 1 + Math.sin(elapsed * 25) * 0.15 * (level + 0.3) : 1);
      speakerRingMat.color.copy(primaryColor);
      txLight.intensity = isAct ? 3.5 * glowIntensity : 0.8;
      txLight.color.copy(primaryColor);

      rxLight.intensity = isAct ? 3.0 * (level + 0.5) : 0.6;
      micRing.scale.setScalar(isAct ? 1 + Math.cos(elapsed * 25) * 0.12 * (level + 0.3) : 1);

      // Animate Wave Ribbon (Continuous 3D Sound Carrier)
      const positions = curveGeo.attributes.position.array as Float32Array;
      const colors = curveGeo.attributes.color.array as Float32Array;
      const cycles = isBit1 ? 14 : 8;
      const amp = isAct ? 0.35 + Math.min(0.5, level * 0.8) : 0.08;

      for (let i = 0; i < curvePointsCount; i++) {
        const u = i / (curvePointsCount - 1);
        const x = -4.0 + u * 8.0;
        const wave = Math.sin(u * Math.PI * 2 * cycles - elapsed * 12);
        const noiseWobble = curNoise > 0.1 ? (Math.random() - 0.5) * curNoise * 0.4 : 0;
        const y = 0.2 + (wave + noiseWobble) * amp;
        const z = Math.cos(u * Math.PI * 2 * cycles - elapsed * 12) * amp * 0.6;

        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        // Color gradient along ribbon
        const colorRatio = u;
        colors[i * 3] = THREE.MathUtils.lerp(primaryColor.r, 0.1, colorRatio * 0.4);
        colors[i * 3 + 1] = THREE.MathUtils.lerp(primaryColor.g, 0.8, colorRatio);
        colors[i * 3 + 2] = THREE.MathUtils.lerp(primaryColor.b, 0.4, colorRatio);
      }
      curveGeo.attributes.position.needsUpdate = true;
      curveGeo.attributes.color.needsUpdate = true;
      curveMat.opacity = isAct ? 0.95 : 0.25;

      // Animate Air Particles (Longitudinal Compression / Rarefaction)
      const pPositions = particleGeo.attributes.position.array as Float32Array;
      const pColors = particleGeo.attributes.color.array as Float32Array;
      const waveFreqFactor = (freq || 1600) / 1000;

      for (let i = 0; i < particleCount; i++) {
        const baseX = particleBasePositions[i * 3];
        const baseY = particleBasePositions[i * 3 + 1];
        const baseZ = particleBasePositions[i * 3 + 2];

        // Compression displacement along X axis
        const distFromTx = baseX + 4.0;
        const phaseOffset = distFromTx * waveFreqFactor * 1.8 - elapsed * 15;
        const displacement = isAct ? Math.sin(phaseOffset) * 0.22 * Math.max(0.3, level) : Math.sin(phaseOffset) * 0.02;

        pPositions[i * 3] = baseX + displacement;
        pPositions[i * 3 + 1] = baseY;
        pPositions[i * 3 + 2] = baseZ;

        // Particle glow brightness in compression zones
        const brightness = 0.3 + (Math.sin(phaseOffset) + 1) * 0.35 * (isAct ? 1 : 0.2);
        pColors[i * 3] = primaryColor.r * brightness;
        pColors[i * 3 + 1] = primaryColor.g * brightness;
        pColors[i * 3 + 2] = primaryColor.b * brightness;
      }
      particleGeo.attributes.position.needsUpdate = true;
      particleGeo.attributes.color.needsUpdate = true;
      particleMat.visible = showParticles;

      // Animate Wavefront Rings
      if (showWavefronts) {
        for (let i = 0; i < ringCount; i++) {
          const ring = waveRings[i];
          const speed = 3.6; // Units per second
          const cycleOffset = (i / ringCount) * 8.0;
          const pos = ((elapsed * speed + cycleOffset) % 8.2);
          const x = -4.0 + pos;

          ring.position.x = x;
          const radiusScale = 0.3 + (pos / 8.0) * 1.6;
          ring.scale.set(radiusScale, radiusScale, radiusScale);

          const fade = Math.sin((pos / 8.2) * Math.PI);
          const ringMat = ring.material as THREE.MeshBasicMaterial;
          ringMat.opacity = isAct ? fade * 0.45 * Math.max(0.3, level) : 0;
          ringMat.color.copy(primaryColor);
        }
      } else {
        waveRings.forEach((r) => ((r.material as THREE.MeshBasicMaterial).opacity = 0));
      }

      renderer.render(scene, camera);
    };

    animate();

    // 11. Handle Resizing
    const handleResize = () => {
      if (!container) return;
      const newWidth = container.clientWidth;
      const newHeight = container.clientHeight;
      const aspect = newWidth / newHeight;
      camera.aspect = aspect;
      // On narrow mobile portrait screens, push camera slightly back so both devices remain in view
      if (aspect < 1.3) {
        camera.position.z = Math.min(18, 12 * (1.3 / Math.max(0.65, aspect)));
      } else {
        camera.position.z = 12;
      }
      camera.updateProjectionMatrix();
      renderer.setSize(newWidth, newHeight);
    };

    handleResize();
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      domEl.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      domEl.removeEventListener("wheel", onWheel);
      domEl.removeEventListener("touchstart", onTouchStart);
      domEl.removeEventListener("touchmove", onTouchMove);
      domEl.removeEventListener("touchend", onTouchEnd);
      renderer.dispose();
      if (domEl.parentNode) domEl.parentNode.removeChild(domEl);
    };
  }, [showParticles, showWavefronts]);

  return (
    <div className="relative w-full h-[260px] sm:h-[340px] md:h-[420px] rounded-2xl overflow-hidden bg-[#141413] border border-stone-800 shadow-xl touch-none select-none">
      {/* Three.js Container */}
      <div ref={containerRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

      {/* 3D Scene HUD Overlay */}
      <div className="absolute top-2.5 left-2.5 sm:top-3 sm:left-3 flex flex-wrap items-center gap-1.5 pointer-events-none max-w-[60%] sm:max-w-none">
        <span className="flex items-center gap-1.5 px-2 sm:px-3 py-1 rounded-lg bg-[#201f1c]/90 border border-stone-700/60 text-[10px] sm:text-[11px] font-claude-mono tracking-wide text-stone-300 backdrop-blur-md">
          <Sparkles size={11} className={active ? "animate-spin text-[#d97757]" : "text-stone-500"} />
          <span className="hidden xs:inline">3D Field · </span>{statusText}
        </span>
        {active && (
          <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-950/85 border border-emerald-800/60 text-[10px] sm:text-[11px] font-claude-mono text-emerald-300 backdrop-blur-md">
            Bit {bit} · {(frequency / 1000).toFixed(1)}kHz
          </span>
        )}
      </div>

      {/* Interactive Controls Overlay */}
      <div className="absolute top-2.5 right-2.5 sm:top-3 sm:right-3 flex items-center gap-1 sm:gap-2">
        <button
          onClick={() => setShowParticles(!showParticles)}
          className={`px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-claude-mono rounded-lg border transition-all ${
            showParticles
              ? "bg-[#2b2a26] border-stone-600 text-[#f5efe6]"
              : "bg-stone-900/70 border-stone-800 text-stone-500"
          }`}
          title="Toggle Air Molecule Particles"
        >
          {showParticles ? "Particles" : "No Particles"}
        </button>

        <button
          onClick={() => setShowWavefronts(!showWavefronts)}
          className={`px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-claude-mono rounded-lg border transition-all ${
            showWavefronts
              ? "bg-[#2b2a26] border-stone-600 text-[#f5efe6]"
              : "bg-stone-900/70 border-stone-800 text-stone-500"
          }`}
          title="Toggle Acoustic Wavefront Rings"
        >
          {showWavefronts ? "Waves" : "No Waves"}
        </button>
      </div>

      {/* Bottom Telemetry Bar */}
      <div className="absolute bottom-2 inset-x-2 sm:inset-x-3 flex items-center justify-between text-[10px] sm:text-[11px] font-claude-mono text-stone-400 bg-[#1c1b18]/90 border border-stone-800 px-2.5 sm:px-3.5 py-1.5 sm:py-2 rounded-xl backdrop-blur-md pointer-events-none">
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="flex items-center gap-1 text-[#d97757]">
            <Volume2 size={12} /> TX (Speaker)
          </span>
          <span className="hidden sm:inline text-stone-600">┈┈ 0.5–2m Air ┈┈</span>
          <span className="sm:hidden text-stone-600">→</span>
          <span className="flex items-center gap-1 text-emerald-400">
            <Mic size={12} /> RX (Mic)
          </span>
        </div>
        <div className="hidden md:flex items-center gap-2 text-stone-500">
          <span>Drag to orbit 360° · Scroll to zoom</span>
        </div>
      </div>
    </div>
  );
}
