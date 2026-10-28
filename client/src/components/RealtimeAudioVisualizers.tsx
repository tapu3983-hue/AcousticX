import React, { useEffect, useRef } from "react";

interface SpectrumProps {
  analyser: AnalyserNode | null;
  lowHz: number;
  highHz: number;
  active: boolean;
  bit: number;
}

export function RealtimeSpectrumCanvas({ analyser, lowHz, highHz, active, bit }: SpectrumProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    const bufferLength = analyser ? analyser.frequencyBinCount : 256;
    const dataArray = new Uint8Array(bufferLength);

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(260, Math.floor(rect.width));
      const h = Math.max(64, Math.floor(rect.height || 76));

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(container);

    const render = () => {
      animId = requestAnimationFrame(render);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;

      ctx.save();
      ctx.scale(dpr, dpr);

      // Warm charcoal background (Claude style)
      ctx.fillStyle = "#181816";
      ctx.fillRect(0, 0, width, height);

      // Warm subtle grid lines
      ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
      ctx.lineWidth = 1;
      const gridStep = width < 400 ? 40 : 50;
      for (let x = 0; x < width; x += gridStep) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y < height; y += 22) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      if (analyser) {
        analyser.getByteFrequencyData(dataArray);
      } else {
        // Idle ambient baseline
        for (let i = 0; i < dataArray.length; i++) {
          dataArray[i] = Math.max(0, Math.floor(Math.random() * 3));
        }
      }

      const sampleRate = analyser?.context.sampleRate || 48000;
      const nyquist = sampleRate / 2;
      // Adaptive bar count for mobile vs desktop
      const barCount = Math.min(56, Math.max(24, Math.floor(width / 7)));
      const barSpacing = width < 380 ? 1.5 : 2;
      const barWidth = Math.max(2, (width - (barCount + 1) * barSpacing) / barCount);

      for (let i = 0; i < barCount; i++) {
        const freq = (i / barCount) * Math.min(22000, nyquist);
        const binIndex = Math.min(bufferLength - 1, Math.round((freq / nyquist) * bufferLength));
        const value = dataArray[binIndex] || 0;
        const barHeight = Math.max(2, (value / 255) * (height - 12));

        const x = barSpacing + i * (barWidth + barSpacing);
        const y = height - barHeight;

        const isNearLow = Math.abs(freq - lowHz) < 320;
        const isNearHigh = Math.abs(freq - highHz) < 320;

        let fill = "rgba(217, 119, 87, 0.35)"; // subtle terracotta
        if (isNearLow) {
          fill = bit === 0 && active ? "#d97757" : "rgba(217, 119, 87, 0.75)";
        } else if (isNearHigh) {
          fill = bit === 1 && active ? "#10b981" : "rgba(16, 185, 129, 0.75)";
        }

        ctx.fillStyle = fill;
        ctx.fillRect(x, y, barWidth, barHeight);

        // Top glow cap on active peaks
        if (value > 30) {
          ctx.fillStyle = isNearHigh ? "#34d399" : "#e28a6d";
          ctx.fillRect(x, y - 2, barWidth, 2);
        }
      }

      // Carrier frequency guide markers
      const lowX = (lowHz / Math.min(22000, nyquist)) * width;
      const highX = (highHz / Math.min(22000, nyquist)) * width;

      ctx.strokeStyle = bit === 0 && active ? "#d97757" : "rgba(217, 119, 87, 0.35)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(lowX, 0);
      ctx.lineTo(lowX, height);
      ctx.stroke();

      ctx.strokeStyle = bit === 1 && active ? "#10b981" : "rgba(16, 185, 129, 0.35)";
      ctx.beginPath();
      ctx.moveTo(highX, 0);
      ctx.lineTo(highX, height);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.restore();
    };

    render();
    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
    };
  }, [analyser, lowHz, highHz, active, bit]);

  return (
    <div ref={containerRef} className="relative w-full h-[76px] sm:h-[84px] overflow-hidden rounded-xl border border-stone-800 bg-[#181816]">
      <canvas ref={canvasRef} className="w-full h-full block" />
      <div className="absolute top-2 right-2 text-[9px] font-mono text-stone-400 bg-stone-900/85 px-1.5 sm:px-2 py-0.5 rounded border border-stone-800 pointer-events-none">
        1024-PT FFT
      </div>
    </div>
  );
}

interface OscilloscopeProps {
  analyser: AnalyserNode | null;
  active: boolean;
  bit: number;
}

export function RealtimeOscilloscopeCanvas({ analyser, active, bit }: OscilloscopeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    const bufferLength = analyser ? analyser.fftSize : 512;
    const timeArray = new Float32Array(bufferLength);

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(260, Math.floor(rect.width));
      const h = Math.max(64, Math.floor(rect.height || 76));

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(container);

    const render = () => {
      animId = requestAnimationFrame(render);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;

      ctx.save();
      ctx.scale(dpr, dpr);

      ctx.fillStyle = "#181816";
      ctx.fillRect(0, 0, width, height);

      // Center baseline
      ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();

      if (analyser && active) {
        analyser.getFloatTimeDomainData(timeArray);
      } else {
        for (let i = 0; i < timeArray.length; i++) {
          timeArray[i] = (Math.random() - 0.5) * 0.008;
        }
      }

      ctx.lineWidth = width < 400 ? 1.75 : 2;
      ctx.strokeStyle = bit === 1 && active ? "#10b981" : "#d97757";
      ctx.shadowBlur = active ? 6 : 1;
      ctx.shadowColor = bit === 1 && active ? "#10b981" : "#d97757";

      ctx.beginPath();
      const sliceWidth = width / (timeArray.length - 1);
      let x = 0;

      for (let i = 0; i < timeArray.length; i++) {
        const v = timeArray[i];
        const y = height / 2 + v * (height * 0.44);

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }

      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();
    };

    render();
    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
    };
  }, [analyser, active, bit]);

  return (
    <div ref={containerRef} className="relative w-full h-[76px] sm:h-[84px] overflow-hidden rounded-xl border border-stone-800 bg-[#181816]">
      <canvas ref={canvasRef} className="w-full h-full block" />
      <div className="absolute top-2 right-2 text-[9px] font-mono text-stone-400 bg-stone-900/85 px-1.5 sm:px-2 py-0.5 rounded border border-stone-800 pointer-events-none">
        WAVEFORM
      </div>
    </div>
  );
}
