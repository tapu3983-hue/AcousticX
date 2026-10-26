export type FrequencyPreset = "audible" | "high" | "ultrasonic" | "custom";

export interface FrequencyConfig {
  name: string;
  lowHz: number;
  highHz: number;
  description: string;
}

export const FREQUENCY_PRESETS: Record<FrequencyPreset, FrequencyConfig> = {
  audible: {
    name: "Standard Audible (Recommended)",
    lowHz: 1600,
    highHz: 2200,
    description: "Optimal for laptop speakers and phone microphones through open room air.",
  },
  high: {
    name: "High Tone",
    lowHz: 4800,
    highHz: 5800,
    description: "Crisp high frequency with lower room noise.",
  },
  ultrasonic: {
    name: "Near Ultrasonic (Quiet)",
    lowHz: 17500,
    highHz: 19500,
    description: "Near-inaudible band for capable hardware.",
  },
  custom: {
    name: "Custom Frequencies",
    lowHz: 1800,
    highHz: 2400,
    description: "User-defined carrier tone pair.",
  },
};

export const DEFAULT_LOW_HZ = 1600;
export const DEFAULT_HIGH_HZ = 2200;
export const DEFAULT_SYMBOL_MS = 38; // 38ms per bit = rock solid against indoor reverberation
export const PREAMBLE_MELODY = [1200, 1600, 2000, 2400]; // 4-note musical leader chime
export const PREAMBLE_BITS: number[] = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
const SYNC = 0xd391;
const MAX_PAYLOAD_BYTES = 256;

export type FskFrame = {
  bytes: Uint8Array;
  bits: number[];
  payload: string;
};

export function crc8(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function byteBits(value: number): number[] {
  return Array.from({ length: 8 }, (_, i) => (value >> (7 - i)) & 1);
}

function wordBits(value: number): number[] {
  return [...byteBits((value >> 8) & 0xff), ...byteBits(value & 0xff)];
}

function bitsToByte(bits: number[], offset: number): number {
  let value = 0;
  for (let i = 0; i < 8; i += 1) value = (value << 1) | (bits[offset + i] ?? 0);
  return value;
}

function bitsToWord(bits: number[], offset: number): number {
  return ((bitsToByte(bits, offset) << 8) | bitsToByte(bits, offset + 8)) >>> 0;
}

function bitsToBytes(bits: number[], offset: number, count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) bytes[i] = bitsToByte(bits, offset + i * 8);
  return bytes;
}

export function encodeFrame(message: string): FskFrame {
  const payload = new TextEncoder().encode(message.trim());
  if (payload.length === 0) throw new Error("Please enter a message to transmit.");
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error(`Keep the message under ${MAX_PAYLOAD_BYTES} characters.`);
  const body = new Uint8Array(payload.length + 2);
  body[0] = (payload.length >> 8) & 0xff;
  body[1] = payload.length & 0xff;
  body.set(payload, 2);
  const checksum = crc8(body);
  const bits = [
    ...PREAMBLE_BITS,
    ...wordBits(SYNC),
    ...wordBits(payload.length),
    ...Array.from(body.slice(2)).flatMap(byteBits),
    ...byteBits(checksum),
  ];
  return { bytes: body, bits, payload: message.trim() };
}

export function makeContext(): AudioContext {
  const Constructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) throw new Error("Web Audio API is not supported in this browser.");
  return new Constructor();
}

export function prepareAudioContext(): AudioContext {
  const context = makeContext();
  if (context.state === "suspended") void context.resume().catch(() => undefined);
  return context;
}

/** Play a subtle, pleasant reception chime */
export function playChime() {
  try {
    const ctx = makeContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.55);
  } catch {
    /* ignore */
  }
}

/**
 * Transmits an FSK frame over the local device speaker.
 * Synthesizes a distinctive musical preamble chime (1200->1600->2000->2400 Hz)
 * followed by smooth continuous-phase FSK carrier tones.
 */
export async function transmitFrame(
  frame: FskFrame,
  lowHz: number,
  highHz: number,
  signal?: AbortSignal,
  onBit?: (bit: number, index: number, freq: number) => void,
  noiseLevel = 0,
  preparedContext?: AudioContext,
  onAnalyserReady?: (analyser: AnalyserNode) => void,
  symbolMs = DEFAULT_SYMBOL_MS
): Promise<void> {
  const context = preparedContext ?? makeContext();
  try {
    if (context.state === "suspended") await context.resume();

    // 1. Calculate durations
    const chimeToneSeconds = 0.07; // 70ms per chime note
    const chimeTotalSamples = Math.round(PREAMBLE_MELODY.length * chimeToneSeconds * context.sampleRate);
    const symbolSeconds = symbolMs / 1000;
    const dataTotalSamples = Math.ceil(frame.bits.length * symbolSeconds * context.sampleRate);
    const totalSamples = chimeTotalSamples + dataTotalSamples;

    const audio = context.createBuffer(1, totalSamples, context.sampleRate);
    const samples = audio.getChannelData(0);
    const rampSamples = Math.max(2, Math.round(context.sampleRate * 0.003)); // 3ms smooth raised cosine ramp

    // 2. Synthesize Musical Leader Chime
    let sampleOffset = 0;
    for (let c = 0; c < PREAMBLE_MELODY.length; c++) {
      const freq = PREAMBLE_MELODY[c];
      const start = Math.round(c * chimeToneSeconds * context.sampleRate);
      const end = Math.round((c + 1) * chimeToneSeconds * context.sampleRate);
      let chimePhase = 0;

      for (let s = start; s < end; s++) {
        const local = s - start;
        const remaining = end - s;
        let env = 1;
        if (local < rampSamples) env = 0.5 * (1 - Math.cos((Math.PI * local) / rampSamples));
        else if (remaining < rampSamples) env = 0.5 * (1 - Math.cos((Math.PI * remaining) / rampSamples));

        samples[s] = Math.sin(chimePhase) * 0.9 * env;
        chimePhase += (2 * Math.PI * freq) / context.sampleRate;
        if (chimePhase > Math.PI * 2) chimePhase -= Math.PI * 2;
      }
    }
    sampleOffset = chimeTotalSamples;

    // 3. Synthesize Continuous-Phase FSK Data Payload
    let phase = 0;
    let interferencePhase = 0;

    for (let index = 0; index < frame.bits.length; index += 1) {
      if (signal?.aborted) throw new DOMException("Transmission stopped.", "AbortError");
      const bit = frame.bits[index];
      const frequency = bit ? highHz : lowHz;
      const interferenceFrequency = bit ? lowHz : highHz;
      const start = sampleOffset + Math.round(index * symbolSeconds * context.sampleRate);
      const end = sampleOffset + Math.min(dataTotalSamples, Math.round((index + 1) * symbolSeconds * context.sampleRate));

      for (let sample = start; sample < end && sample < totalSamples; sample += 1) {
        const local = sample - start;
        const remaining = end - sample;
        let envelope = 1;
        if (local < rampSamples) {
          envelope = 0.5 * (1 - Math.cos((Math.PI * local) / rampSamples));
        } else if (remaining < rampSamples) {
          envelope = 0.5 * (1 - Math.cos((Math.PI * remaining) / rampSamples));
        }

        const tone = Math.sin(phase);
        const interference = Math.sin(interferencePhase) * Math.max(0, Math.min(0.6, noiseLevel)) * 1.2;
        samples[sample] = (tone + interference) * 0.88 * envelope;

        phase += (2 * Math.PI * frequency) / context.sampleRate;
        if (phase > Math.PI * 2) phase -= Math.PI * 2;
        interferencePhase += (2 * Math.PI * interferenceFrequency) / context.sampleRate;
        if (interferencePhase > Math.PI * 2) interferencePhase -= Math.PI * 2;
      }
    }

    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    onAnalyserReady?.(analyser);

    await new Promise<void>((resolve, reject) => {
      const source = context.createBufferSource();
      const gain = context.createGain();
      gain.gain.value = 0.95;

      source.buffer = audio;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(context.destination);

      let bitIndex = 0;
      // Start bit reporting after chime finishes
      const chimeMs = PREAMBLE_MELODY.length * chimeToneSeconds * 1000;
      let progressTimer: number | undefined;

      const timerStarter = window.setTimeout(() => {
        progressTimer = window.setInterval(() => {
          if (bitIndex < frame.bits.length) {
            const bit = frame.bits[bitIndex];
            const freq = bit ? highHz : lowHz;
            onBit?.(bit, bitIndex++, freq);
          }
        }, symbolMs);
      }, chimeMs);

      const abort = () => {
        window.clearTimeout(timerStarter);
        if (progressTimer) window.clearInterval(progressTimer);
        try { source.stop(); } catch { /* ignore */ }
        reject(new DOMException("Transmission stopped.", "AbortError"));
      };

      signal?.addEventListener("abort", abort, { once: true });
      source.onended = () => {
        window.clearTimeout(timerStarter);
        if (progressTimer) window.clearInterval(progressTimer);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      source.start();
    });
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Optimized Goertzel algorithm for single-frequency energy extraction */
export function goertzel(samples: Float32Array, sampleRate: number, frequency: number): number {
  const n = samples.length;
  if (n === 0) return 0;
  const k = Math.round((n * frequency) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const coefficient = 2 * Math.cos(omega);
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i += 1) {
    const q0 = samples[i] + coefficient * q1 - q2;
    q2 = q1;
    q1 = q0;
  }
  const power = q1 * q1 + q2 * q2 - coefficient * q1 * q2;
  return Math.max(0, power / (n * n));
}

type ToneRecord = { time: number; bit: number | null; confidence: number; energy: number; low: number; high: number };

function recoverPreambleTiming(records: ToneRecord[], approximateStart: number, nominalMs: number) {
  let best: { start: number; period: number; matches: number; score: number } | null = null;
  for (let offset = -20; offset <= 20; offset += 0.5) {
    let matches = 0;
    let score = 0;
    const start = approximateStart + offset;
    for (let i = 0; i < PREAMBLE_BITS.length; i += 1) {
      const center = start + (i + 0.5) * nominalMs;
      let nearest: ToneRecord | null = null;
      let minDiff = Infinity;
      for (const rec of records) {
        const diff = Math.abs(rec.time - center);
        if (diff < minDiff) {
          minDiff = diff;
          nearest = rec;
        }
      }
      if (nearest && minDiff <= nominalMs * 0.45 && nearest.bit === PREAMBLE_BITS[i]) {
        matches += 1;
        score += nearest.confidence;
      }
    }
    if (!best || matches > best.matches || (matches === best.matches && score > best.score)) {
      best = { start, period: nominalMs, matches, score };
    }
  }
  return best && best.matches >= PREAMBLE_BITS.length - 3 ? best : null;
}

function decodeSamples(
  bits: number[]
): { message: string; payloadBytes: Uint8Array; crcValid: boolean } | null {
  if (bits.length < PREAMBLE_BITS.length + 32) return null;

  let preambleErrors = 0;
  for (let i = 0; i < PREAMBLE_BITS.length; i += 1) {
    if (bits[i] !== PREAMBLE_BITS[i]) preambleErrors += 1;
  }
  if (preambleErrors > 3) return null;

  const syncAt = PREAMBLE_BITS.length;
  const decodedSync = bitsToWord(bits, syncAt);
  // Allow 1 bit error in sync word
  const syncDiff = (decodedSync ^ SYNC).toString(2).split("1").length - 1;
  if (syncDiff > 1) return null;

  const lengthAt = syncAt + 16;
  const length = bitsToWord(bits, lengthAt);
  if (length < 1 || length > MAX_PAYLOAD_BYTES) {
    return null;
  }

  const completeBits = PREAMBLE_BITS.length + 16 + 16 + length * 8 + 8;
  if (bits.length < completeBits) return null;

  const payloadAt = lengthAt + 16;
  const payloadBytes = bitsToBytes(bits, payloadAt, length);
  const receivedCrc = bitsToByte(bits, payloadAt + length * 8);

  const crcInput = new Uint8Array(length + 2);
  crcInput[0] = (length >> 8) & 0xff;
  crcInput[1] = length & 0xff;
  crcInput.set(payloadBytes, 2);

  const crcValid = crc8(crcInput) === receivedCrc;
  const message = new TextDecoder("utf-8", { fatal: false }).decode(payloadBytes);
  return { message, payloadBytes, crcValid };
}

export type ContinuousReceiveCallbacks = {
  onStatus: (status: "listening" | "detected" | "decoding" | "success" | "idle") => void;
  onTone: (tone: { bit: number; frequency: number; confidence: number }) => void;
  onBits: (preview: string) => void;
  onLevel: (level: number, snrDb: number) => void;
  onSoundStart?: () => void;
  onSoundStop?: (acousticDurationMs: number) => void;
  onMessageDecoded: (result: { message: string; crcValid: boolean }) => void;
  onAnalyserReady?: (analyser: AnalyserNode) => void;
};

/**
 * Continuous, auto-detecting Acoustic Receiver with Musical Chime Lock.
 * Only engages when hearing the distinct acoustic carrier tones, ignores room noise,
 * and automatically finalizes/stops when the music finishes!
 */
export async function startContinuousReceiver(
  options: {
    lowHz: number;
    highHz: number;
    signal: AbortSignal;
    symbolMs?: number;
  } & ContinuousReceiveCallbacks
): Promise<void> {
  const {
    lowHz,
    highHz,
    signal,
    onStatus,
    onTone,
    onBits,
    onLevel,
    onSoundStart,
    onSoundStop,
    onMessageDecoded,
    onAnalyserReady,
    symbolMs = DEFAULT_SYMBOL_MS,
  } = options;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone requires HTTPS or localhost.");
  }

  const audioContext = makeContext();
  if (audioContext.state === "suspended") await audioContext.resume();

  const microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: { ideal: 48_000 },
    },
  });

  const source = audioContext.createMediaStreamSource(microphoneStream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.1;
  source.connect(analyser);
  onAnalyserReady?.(analyser);

  const bufferSize = 1024;
  const processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
  source.connect(processorNode);

  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  processorNode.connect(silentGain);
  silentGain.connect(audioContext.destination);

  const records: ToneRecord[] = [];
  let noiseFloor = 0.000001;
  let activeStart: number | null = null;
  let lastActiveTime = 0;
  let soundStartTime = 0;
  let timingLocked: { start: number; period: number } | null = null;
  let timingAttempted = false;
  let isSignalActive = false;
  let accumulatedBits: number[] = [];

  onStatus("listening");

  const cleanup = () => {
    try { processorNode.disconnect(); } catch { /* ignore */ }
    microphoneStream.getTracks().forEach((track) => track.stop());
    void audioContext.close().catch(() => undefined);
  };

  signal.addEventListener("abort", cleanup, { once: true });

  processorNode.onaudioprocess = (event) => {
    if (signal.aborted) return;
    const now = performance.now();
    const inputData = event.inputBuffer.getChannelData(0);

    const low = goertzel(inputData, audioContext.sampleRate, lowHz);
    const high = goertzel(inputData, audioContext.sampleRate, highHz);
    const chimeLow = goertzel(inputData, audioContext.sampleRate, PREAMBLE_MELODY[0]);
    const chimeHigh = goertzel(inputData, audioContext.sampleRate, PREAMBLE_MELODY[PREAMBLE_MELODY.length - 1]);
    const totalCarrierEnergy = low + high + chimeLow + chimeHigh;

    // Ambient room noise adaptation
    if (!isSignalActive) {
      noiseFloor = noiseFloor * 0.95 + totalCarrierEnergy * 0.05;
    }

    const carrierThreshold = Math.max(0.00000008, noiseFloor * 3.5);
    const strongestCarrier = Math.max(low, high);
    const carrierConfidence = (low + high) > 0 ? strongestCarrier / (low + high) : 0;
    const snrDb = noiseFloor > 0 ? 10 * Math.log10(Math.max(1, strongestCarrier / noiseFloor)) : 0;

    // Reject random speech and room noise: requires specific tone dominance
    const isChimeOrCarrier = (totalCarrierEnergy > carrierThreshold * 1.5 && carrierConfidence > 0.55) || (chimeLow > carrierThreshold || chimeHigh > carrierThreshold);
    const bit = (low + high) > carrierThreshold && carrierConfidence > 0.58 ? (high > low ? 1 : 0) : null;

    records.push({ time: now, bit, confidence: carrierConfidence, energy: totalCarrierEnergy, low, high });
    while (records.length && records[0].time < now - 15_000) records.shift();

    const normalizedLevel = Math.min(1, Math.max(0, (totalCarrierEnergy - noiseFloor) / Math.max(noiseFloor * 8, 0.00001)));
    onLevel(normalizedLevel, snrDb);

    // 1. SOUND START DETECTION
    if (isChimeOrCarrier) {
      lastActiveTime = now;
      if (!isSignalActive) {
        isSignalActive = true;
        soundStartTime = now;
        onSoundStart?.();
        onStatus("detected");
      }

      if (activeStart === null && bit === 1) {
        activeStart = now;
        timingAttempted = false;
      }
    }

    // 2. SOUND STOP AUTO-DETECTION:
    // When sound finishes playing in room and drops below threshold for > 350ms, AUTO-STOP!
    if (isSignalActive && now - lastActiveTime > 350) {
      const soundDuration = now - soundStartTime;
      isSignalActive = false;
      onSoundStop?.(soundDuration);

      // Check if acoustic demodulation succeeded
      if (accumulatedBits.length >= PREAMBLE_BITS.length + 32) {
        const decoded = decodeSamples(accumulatedBits);
        if (decoded && decoded.message) {
          playChime();
          onMessageDecoded({ message: decoded.message, crcValid: decoded.crcValid });
          onStatus("success");
        }
      }

      // Reset
      activeStart = null;
      timingLocked = null;
      accumulatedBits = [];
    }

    // 3. CONTINUOUS SYMBOL RECOVERY
    if (activeStart !== null) {
      const elapsed = now - activeStart;
      const tentativeSymbols = Math.floor(elapsed / symbolMs);

      if (timingLocked === null && !timingAttempted && tentativeSymbols >= PREAMBLE_BITS.length) {
        timingAttempted = true;
        const timing = recoverPreambleTiming(records, activeStart, symbolMs);
        if (timing) {
          timingLocked = { start: timing.start, period: timing.period };
          onStatus("decoding");
        }
      }

      if (timingLocked !== null) {
        const frameStart = timingLocked.start;
        const totalBits = Math.floor((now - frameStart) / timingLocked.period) + 1;
        const sampledBits: number[] = [];

        for (let i = 0; i < totalBits; i += 1) {
          const center = frameStart + (i + 0.5) * timingLocked.period;
          let nearest: ToneRecord | null = null;
          let minDiff = Infinity;
          for (const rec of records) {
            const diff = Math.abs(rec.time - center);
            if (diff < minDiff) {
              minDiff = diff;
              nearest = rec;
            }
          }

          if (nearest && nearest.bit !== null) {
            sampledBits.push(nearest.bit);
            if (i >= PREAMBLE_BITS.length) {
              onTone({ bit: nearest.bit, frequency: nearest.bit ? highHz : lowHz, confidence: nearest.confidence });
            }
          }
        }

        accumulatedBits = sampledBits;
        if (sampledBits.length > PREAMBLE_BITS.length + 32) {
          const payloadPortion = sampledBits.slice(PREAMBLE_BITS.length + 32).join("");
          const preview = payloadPortion.length > 24 ? `${payloadPortion.slice(0, 24)}…` : payloadPortion;
          onBits(preview);

          const immediateResult = decodeSamples(sampledBits);
          if (immediateResult && immediateResult.crcValid) {
            playChime();
            onMessageDecoded({ message: immediateResult.message, crcValid: true });
            onStatus("success");
            activeStart = null;
            timingLocked = null;
            accumulatedBits = [];
          }
        }
      }
    }
  };
}

/** Web Speech API Recognition Wrapper */
export function startLiveSpeech(
  onTranscript: (text: string, isFinal: boolean) => void,
  onError?: (error: string) => void
): { stop: () => void } | null {
  const SpeechRecognition =
    (window as unknown as { SpeechRecognition?: any }).SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: any }).webkitSpeechRecognition;

  if (!SpeechRecognition) {
    onError?.("Speech recognition is not supported in this browser. You can type directly.");
    return null;
  }

  try {
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: any) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      const text = final || interim;
      if (text) {
        onTranscript(text.trim(), !!final);
      }
    };

    recognition.onerror = (e: any) => {
      if (e.error !== "no-speech") {
        onError?.(e.error || "Speech error");
      }
    };

    recognition.start();
    return {
      stop: () => {
        try { recognition.stop(); } catch { /* ignore */ }
      },
    };
  } catch (err) {
    onError?.(err instanceof Error ? err.message : "Failed to start speech");
    return null;
  }
}
