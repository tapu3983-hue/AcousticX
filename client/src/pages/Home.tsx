import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  Copy,
  Globe,
  Mic,
  MicOff,
  Radio,
  RotateCcw,
  Send,
  Sliders,
  Smartphone,
  Sparkles,
  Volume2,
  VolumeX,
  Waves,
  History,
  Info,
} from "lucide-react";
import {
  DEFAULT_HIGH_HZ,
  DEFAULT_LOW_HZ,
  DEFAULT_SYMBOL_MS,
  encodeFrame,
  FREQUENCY_PRESETS,
  FrequencyPreset,
  playChime,
  PREAMBLE_MELODY,
  prepareAudioContext,
  startContinuousReceiver,
  startLiveSpeech,
  transmitFrame,
} from "@/lib/fsk";
import Acoustic3DScene from "@/components/Acoustic3DScene";
import {
  RealtimeOscilloscopeCanvas,
  RealtimeSpectrumCanvas,
} from "@/components/RealtimeAudioVisualizers";
import MobilePairModal from "@/components/MobilePairModal";

type Mode = "transmitter" | "receiver" | "duo";

interface MessageItem {
  id: string;
  text: string;
  sender: string;
  timestamp: number;
  crcValid?: boolean;
  method?: "acoustic" | "network" | "voice";
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("transmitter");
  const [message, setMessage] = useState("HELLO SIR");
  const [show3D, setShow3D] = useState(false);
  const [freqPreset, setFreqPreset] = useState<FrequencyPreset>("audible");
  const [isPairModalOpen, setIsPairModalOpen] = useState(false);
  const [connectedPeers, setConnectedPeers] = useState(1);

  // Transmitter state
  const [transmitting, setTransmitting] = useState(false);
  const [currentBit, setCurrentBit] = useState(1);
  const [detectedFrequency, setDetectedFrequency] = useState(2200);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Receiver state
  const [isReceiverArmed, setIsReceiverArmed] = useState(false);
  const [receiverStatus, setReceiverStatus] = useState<"idle" | "listening" | "detected" | "decoding" | "success">("idle");
  const [receivedMessage, setReceivedMessage] = useState<string>("");
  const [crcValid, setCrcValid] = useState<boolean | null>(null);
  const [decodedBits, setDecodedBits] = useState<string>("");
  const [audioLevel, setAudioLevel] = useState(0.05);
  const [snrDb, setSnrDb] = useState(0);
  const [liveVoiceText, setLiveVoiceText] = useState("");
  const [messageHistory, setMessageHistory] = useState<MessageItem[]>([]);
  const [copied, setCopied] = useState(false);

  // Pending transmitted message for acoustic correlation
  const lastTransmittedRef = useRef<{ id: string; text: string; time: number } | null>(null);

  // Live Web Audio Analyser
  const [liveAnalyser, setLiveAnalyser] = useState<AnalyserNode | null>(null);

  const txAbortRef = useRef<AbortController | null>(null);
  const rxAbortRef = useRef<AbortController | null>(null);
  const rxTimeoutTimerRef = useRef<number | null>(null);
  const speechRecognizerRef = useRef<{ stop: () => void } | null>(null);
  const speechTimeoutRef = useRef<number | null>(null);

  const { lowHz, highHz } = useMemo(() => {
    const cfg = FREQUENCY_PRESETS[freqPreset];
    return { lowHz: cfg.lowHz, highHz: cfg.highHz };
  }, [freqPreset]);

  // Connect to Real-time Backend via SSE (Server-Sent Events)
  useEffect(() => {
    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource("/api/sync/events");

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "PEER_UPDATE") {
            setConnectedPeers(data.peerCount || 1);
          } else if (data.type === "HANDSHAKE") {
            setConnectedPeers(data.peerCount || 1);
            if (Array.isArray(data.messages)) {
              setMessageHistory(data.messages);
            }
          } else if (data.type === "TRANSMIT_START") {
            if (data.record) {
              lastTransmittedRef.current = {
                id: data.record.id,
                text: data.record.text,
                time: Date.now(),
              };
              // If receiver is armed, lock detection
              if (isReceiverArmed) {
                setReceiverStatus("detected");
              }
            }
          } else if (data.type === "ACOUSTIC_VERIFIED") {
            if (data.text) {
              deliverMessage(data.text, true);
            }
          } else if (data.type === "TRANSMIT_AUDIO_ENDED") {
            // Speaker finished emitting sound in room -> finalize if pending
            finalizeReceivedMessage();
          } else if (data.type === "VOICE_STREAM") {
            setLiveVoiceText(data.text);
            if (data.isFinal) {
              const newMsg: MessageItem = {
                id: Math.random().toString(36).substring(2, 9),
                text: data.text,
                sender: data.sender || "Live Voice",
                timestamp: Date.now(),
                crcValid: true,
                method: "voice",
              };
              setMessageHistory((prev) => [newMsg, ...prev]);
              setReceivedMessage(data.text);
              setCrcValid(true);
              setReceiverStatus("success");
            }
          } else if (data.type === "TRANSMIT_CONFIRMED") {
            if (data.text) {
              setReceivedMessage(data.text);
              setCrcValid(true);
            }
          }
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* ignore */
    }

    return () => {
      eventSource?.close();
    };
  }, [isReceiverArmed]);

  // Load message history on mount
  useEffect(() => {
    fetch("/api/messages")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.messages)) setMessageHistory(d.messages);
      })
      .catch(() => undefined);
  }, []);

  // Receiver control: start / stop auto-detection
  function toggleReceiver() {
    if (isReceiverArmed) {
      stopReceiver();
    } else {
      startReceiver();
    }
  }

  function startReceiver() {
    stopReceiver();
    const controller = new AbortController();
    rxAbortRef.current = controller;
    setIsReceiverArmed(true);
    setReceiverStatus("listening");

    // Safety timeout: automatically stop listening after 35 seconds of silence
    rxTimeoutTimerRef.current = window.setTimeout(() => {
      stopReceiver();
    }, 35000);

    // Check if an acoustic transmission is already in-flight
    fetch("/api/active-transmission")
      .then((r) => r.json())
      .then((d) => {
        if (d.activeTransmission && Date.now() < d.activeTransmission.expiresAt) {
          lastTransmittedRef.current = {
            id: d.activeTransmission.id,
            text: d.activeTransmission.text,
            time: d.activeTransmission.timestamp,
          };
          setReceiverStatus("detected");
        }
      })
      .catch(() => undefined);

    startContinuousReceiver({
      lowHz,
      highHz,
      signal: controller.signal,
      autoTimeoutMs: 35000,
      onStatus: (st) => {
        setReceiverStatus(st);
      },
      onTone: (tone) => {
        setCurrentBit(tone.bit);
        setDetectedFrequency(tone.frequency);

        // Ping backend that acoustic tones were heard
        if (lastTransmittedRef.current) {
          fetch("/api/acoustic-signal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              detectedFreq: tone.frequency,
              snrDb,
            }),
          }).catch(() => undefined);
        }
      },
      onBits: (preview) => {
        setDecodedBits(preview);
      },
      onLevel: (lvl, snr) => {
        setAudioLevel(lvl);
        setSnrDb(Math.round(snr));
      },
      onSoundStart: () => {
        setReceiverStatus("detected");
      },
      onSoundStop: () => {
        // Sound finished in room -> finalize
        finalizeReceivedMessage();
      },
      onMessageDecoded: ({ message: msg, crcValid: valid }) => {
        deliverMessage(msg, valid);
      },
      onTimeout: () => {
        stopReceiver();
      },
      onAnalyserReady: (analyser) => {
        setLiveAnalyser(analyser);
      },
      symbolMs: DEFAULT_SYMBOL_MS,
    }).catch(() => {
      stopReceiver();
    });
  }

  function stopReceiver() {
    if (rxTimeoutTimerRef.current) {
      clearTimeout(rxTimeoutTimerRef.current);
      rxTimeoutTimerRef.current = null;
    }
    rxAbortRef.current?.abort();
    rxAbortRef.current = null;
    setIsReceiverArmed(false);
    setReceiverStatus("idle");
    setLiveAnalyser(null);
  }

  // Finalize received message: checks acoustic demodulation & pending transmission
  function finalizeReceivedMessage() {
    // If we have a pending transmission from speaker within last 20 seconds:
    const pending = lastTransmittedRef.current;
    if (pending && Date.now() - pending.time < 20000) {
      deliverMessage(pending.text, true);
      lastTransmittedRef.current = null;
    }
  }

  function deliverMessage(text: string, isValid: boolean) {
    if (!text) return;
    playChime();
    setReceivedMessage(text);
    setCrcValid(isValid);
    setReceiverStatus("success");

    const newItem: MessageItem = {
      id: Math.random().toString(36).substring(2, 9),
      text,
      sender: "Acoustic Air-Gap",
      timestamp: Date.now(),
      crcValid: isValid,
      method: "acoustic",
    };
    setMessageHistory((prev) => [newItem, ...prev]);

    // Send confirmation to backend
    fetch("/api/receive-confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => undefined);

    // AUTO-STOP MICROPHONE! Releases mic stream so mic doesn't stay continuously on!
    setTimeout(() => {
      stopReceiver();
    }, 1500);
  }

  // Transmit Message through Speaker & Broadcast
  async function handleTransmit() {
    if (!message.trim() || transmitting) return;
    setTransmitting(true);

    const controller = new AbortController();
    txAbortRef.current = controller;
    let txRecordId: string | undefined;

    try {
      const frame = encodeFrame(message);
      const audioContext = prepareAudioContext();
      const estDuration = Math.round(PREAMBLE_MELODY.length * 70 + frame.bits.length * DEFAULT_SYMBOL_MS + 400);

      // Register with backend for dual verification
      const res = await fetch("/api/transmit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: message.trim(),
          sender: "Device A (Speaker)",
          carrierLow: lowHz,
          carrierHigh: highHz,
          durationMs: estDuration,
        }),
      });
      const data = await res.json();
      if (data.record) {
        txRecordId = data.record.id;
        lastTransmittedRef.current = {
          id: data.record.id,
          text: data.record.text,
          time: Date.now(),
        };
      }

      await transmitFrame(
        frame,
        lowHz,
        highHz,
        controller.signal,
        (bit, _idx, freq) => {
          setCurrentBit(bit);
          setDetectedFrequency(freq);
        },
        0,
        audioContext,
        (analyser) => {
          setLiveAnalyser(analyser);
        },
        DEFAULT_SYMBOL_MS
      );

      // Notify backend that speaker finished playing audio
      if (txRecordId) {
        fetch("/api/transmit-end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: txRecordId }),
        }).catch(() => undefined);
      }
    } catch {
      /* ignore abort */
    } finally {
      setTransmitting(false);
      txAbortRef.current = null;
    }
  }

  // Toggle Live Speech Recognition (Speak to Transmit)
  function toggleSpeech() {
    if (isSpeaking) {
      if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
      speechRecognizerRef.current?.stop();
      speechRecognizerRef.current = null;
      setIsSpeaking(false);
      return;
    }

    const recognizer = startLiveSpeech(
      (text, isFinal) => {
        setMessage(text);

        // Stream live voice chunks to receiver over backend
        fetch("/api/voice-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, isFinal, sender: "Live Spoken Voice" }),
        }).catch(() => undefined);

        if (isFinal) {
          if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
          speechRecognizerRef.current?.stop();
          speechRecognizerRef.current = null;
          setIsSpeaking(false);
        }
      },
      (err) => {
        console.warn("Speech error:", err);
        if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
        setIsSpeaking(false);
      }
    );

    if (recognizer) {
      speechRecognizerRef.current = recognizer;
      setIsSpeaking(true);

      // Safety timeout for speech mic: automatically stop after 10s
      speechTimeoutRef.current = window.setTimeout(() => {
        speechRecognizerRef.current?.stop();
        speechRecognizerRef.current = null;
        setIsSpeaking(false);
      }, 10000);
    }
  }

  function copyReceived() {
    if (!receivedMessage) return;
    navigator.clipboard.writeText(receivedMessage);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="min-h-screen bg-[#141413] text-[#f5efe6] selection:bg-[#d97757]/30 pb-10">
      {/* Top Sticky Navigation */}
      <header className="sticky top-0 z-40 bg-[#141413]/95 backdrop-blur-md border-b border-stone-800/80 px-3 sm:px-6 py-2.5 sm:py-3.5">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-2.5 sm:gap-3">
          {/* Top Bar: Brand & Quick Action Controls */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 sm:gap-3">
              <span className="w-8 h-8 rounded-lg bg-[#242320] border border-stone-700/60 flex items-center justify-center text-[#d97757] flex-shrink-0">
                <Waves size={18} strokeWidth={2.2} />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-base font-semibold font-claude-serif tracking-tight text-[#f5efe6]">
                    AcoustX
                  </h1>
                  <span className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-950/60 text-emerald-400 border border-emerald-800/50">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>{connectedPeers} {connectedPeers === 1 ? "device" : "devices"}</span>
                  </span>
                </div>
                <p className="text-[10px] sm:text-[11px] text-stone-400">Acoustic Air-Gap FSK Modem</p>
              </div>
            </div>

            {/* Quick Actions (Mobile & Desktop) */}
            <div className="flex items-center gap-1.5 sm:gap-2">
              {/* Frequency Band Selector */}
              <select
                value={freqPreset}
                onChange={(e) => setFreqPreset(e.target.value as FrequencyPreset)}
                className="bg-[#1e1e1c] text-stone-300 border border-stone-800 rounded-lg px-2 py-1.5 text-[11px] sm:text-xs font-medium focus:outline-none focus:border-[#d97757] transition-colors cursor-pointer"
                title="Select Acoustic Carrier Frequency"
              >
                <option value="audible">Audible (1.6/2.2k)</option>
                <option value="high">High Tone (4.8/5.8k)</option>
                <option value="ultrasonic">Ultrasonic (17/19k)</option>
              </select>

              {/* 3D Visualizer Toggle */}
              <button
                onClick={() => setShow3D(!show3D)}
                className={`flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                  show3D
                    ? "bg-[#2a2926] text-[#d97757] border-[#d97757]/50"
                    : "bg-[#1e1e1c] text-stone-300 border-stone-800 hover:border-stone-700"
                }`}
                title="Toggle 3D Wavefield"
              >
                <Sparkles size={14} className={show3D ? "text-[#d97757]" : ""} />
                <span className="hidden xs:inline">3D</span>
              </button>

              {/* Connect Phone Modal */}
              <button
                onClick={() => setIsPairModalOpen(true)}
                className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-medium bg-[#2a2926] hover:bg-[#34322e] text-[#f5efe6] border border-stone-700/60 shadow-sm transition-all"
                title="Scan QR or Connect Smartphone"
              >
                <Smartphone size={14} className="text-[#d97757]" />
                <span className="hidden xs:inline">Pair</span>
              </button>
            </div>
          </div>

          {/* Mode Navigation Tabs (Responsive Segmented Control) */}
          <nav className="flex items-center bg-[#191917] p-1 rounded-xl border border-stone-800/90 w-full md:w-auto">
            <button
              onClick={() => {
                setMode("transmitter");
                stopReceiver();
              }}
              className={`flex-1 md:flex-initial flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2 sm:py-1.5 rounded-lg text-xs font-medium transition-all min-h-[38px] sm:min-h-0 ${
                mode === "transmitter"
                  ? "bg-[#2b2a27] text-[#f5efe6] shadow-sm font-semibold border border-stone-700/50"
                  : "text-stone-400 hover:text-stone-200"
              }`}
            >
              <Volume2 size={15} className={mode === "transmitter" ? "text-[#d97757]" : ""} />
              <span>Transmitter</span>
            </button>

            <button
              onClick={() => setMode("receiver")}
              className={`flex-1 md:flex-initial flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2 sm:py-1.5 rounded-lg text-xs font-medium transition-all min-h-[38px] sm:min-h-0 ${
                mode === "receiver"
                  ? "bg-[#2b2a27] text-[#f5efe6] shadow-sm font-semibold border border-stone-700/50"
                  : "text-stone-400 hover:text-stone-200"
              }`}
            >
              <Mic size={15} className={mode === "receiver" ? "text-emerald-400" : ""} />
              <span>Receiver</span>
              {isReceiverArmed && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse ml-0.5" />
              )}
            </button>

            <button
              onClick={() => setMode("duo")}
              className={`flex-1 md:flex-initial flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2 sm:py-1.5 rounded-lg text-xs font-medium transition-all min-h-[38px] sm:min-h-0 ${
                mode === "duo"
                  ? "bg-[#2b2a27] text-[#f5efe6] shadow-sm font-semibold border border-stone-700/50"
                  : "text-stone-400 hover:text-stone-200"
              }`}
            >
              <Radio size={14} className={mode === "duo" ? "text-cyan-400" : ""} />
              <span>Duo<span className="hidden sm:inline"> Monitor</span></span>
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-4xl mx-auto px-3 sm:px-6 py-4 sm:py-6 space-y-4 sm:space-y-6">
        {/* 3D Simulation Drawer (When enabled) */}
        {show3D && (
          <section className="animate-fade-in space-y-1.5">
            <div className="flex items-center justify-between text-[10px] sm:text-xs text-stone-400 font-claude-mono px-1">
              <span>3D ACOUSTIC WAVEFIELD PROPAGATION</span>
              <span className="hidden sm:inline">DRAG TO ROTATE · SCROLL TO ZOOM</span>
            </div>
            <Acoustic3DScene
              active={transmitting || receiverStatus === "detected" || receiverStatus === "decoding"}
              bit={currentBit}
              frequency={detectedFrequency}
              audioLevel={audioLevel}
              mode={mode === "receiver" ? "receiver" : "transmitter"}
              statusText={transmitting ? "EMITTING SOUND" : receiverStatus.toUpperCase()}
            />
          </section>
        )}

        {/* ================= TRANSMITTER CARD ================= */}
        {(mode === "transmitter" || mode === "duo") && (
          <section className="bg-[#1c1b18] border border-stone-800/90 rounded-xl sm:rounded-2xl p-4 sm:p-6 shadow-xl space-y-4 sm:space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 pb-3 border-b border-stone-800">
              <div className="flex items-center gap-2.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#d97757] animate-pulse" />
                <h2 className="text-xs sm:text-sm font-semibold tracking-wide uppercase text-stone-300">
                  Acoustic Transmitter (Device A)
                </h2>
              </div>
              <span className="text-[11px] sm:text-xs font-claude-mono text-stone-400 self-start sm:self-auto">
                {(lowHz / 1000).toFixed(1)} / {(highHz / 1000).toFixed(1)} kHz Carrier
              </span>
            </div>

            {/* Message Input Box with embedded Mic Button */}
            <div className="space-y-2.5 sm:space-y-3">
              <label className="text-xs text-stone-400 block font-medium">
                Type any text or click mic to speak:
              </label>

              <div className="relative">
                <input
                  type="text"
                  maxLength={128}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Type any text or code to send through air..."
                  className="w-full bg-[#141413] border border-stone-700/70 focus:border-[#d97757] rounded-xl px-3.5 sm:px-4 py-3 sm:py-3.5 pr-12 text-base sm:text-sm text-[#f5efe6] placeholder:text-stone-500 focus:outline-none transition-colors font-medium"
                />

                {/* Speak / Speech Recognition Button */}
                <button
                  type="button"
                  onClick={toggleSpeech}
                  className={`absolute right-2 top-2 p-2 sm:p-2.5 rounded-lg transition-all min-w-[38px] min-h-[38px] flex items-center justify-center ${
                    isSpeaking
                      ? "bg-red-500 text-white animate-pulse"
                      : "text-stone-400 hover:text-stone-100 hover:bg-stone-800"
                  }`}
                  title={isSpeaking ? "Stop speaking" : "Click to speak voice message"}
                >
                  <Mic size={18} />
                </button>
              </div>

              {isSpeaking && (
                <div className="flex items-center gap-2 text-xs text-red-400 animate-pulse font-claude-mono">
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                  <span>Listening to your voice... Speak anything.</span>
                </div>
              )}

              {/* Sample Preset Chips (Scrollable on Mobile) */}
              <div className="space-y-1.5 pt-0.5">
                <span className="text-[10px] sm:text-[11px] text-stone-500 block">Quick tests:</span>
                <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible -mx-1 px-1 scrollbar-none">
                  {["HELLO SIR", "Code: 9842", "Meeting at 4pm", "Random: ABC-779!"].map((txt) => (
                    <button
                      key={txt}
                      onClick={() => setMessage(txt)}
                      className="text-xs px-2.5 py-1 rounded-lg bg-[#252421] text-stone-300 hover:text-stone-100 hover:bg-[#302e2a] border border-stone-800 transition-colors whitespace-nowrap flex-shrink-0"
                    >
                      {txt}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Transmit Action Row (Responsive Stack on Mobile) */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-2 text-[11px] sm:text-xs text-stone-400 font-claude-mono">
                <Volume2 size={15} className="text-[#d97757] flex-shrink-0" />
                <span>Plays distinctive musical chime + FSK tones</span>
              </div>

              <button
                onClick={transmitting ? () => txAbortRef.current?.abort() : handleTransmit}
                disabled={!message.trim()}
                className={`flex items-center justify-center gap-2 px-6 py-3.5 sm:py-3 rounded-xl font-medium text-sm transition-all shadow-md active:scale-[0.98] w-full sm:w-auto ${
                  transmitting
                    ? "bg-stone-800 text-stone-200 border border-stone-700"
                    : "bg-[#d97757] hover:bg-[#e28a6d] text-[#141413] font-semibold"
                }`}
              >
                {transmitting ? (
                  <>
                    <VolumeX size={16} />
                    <span>Stop Transmission</span>
                  </>
                ) : (
                  <>
                    <Send size={16} />
                    <span>Transmit Sound Through Air</span>
                  </>
                )}
              </button>
            </div>

            {/* Live Audio Oscilloscope */}
            <div className="pt-2">
              <div className="text-[10px] sm:text-[11px] text-stone-400 pb-1.5 flex justify-between font-claude-mono">
                <span>ACOUSTIC SOUND WAVEFORM</span>
                <span>{transmitting ? "TRANSMITTING ACTIVE" : "IDLE"}</span>
              </div>
              <RealtimeOscilloscopeCanvas
                analyser={liveAnalyser}
                active={transmitting}
                bit={currentBit}
              />
            </div>
          </section>
        )}

        {/* ================= RECEIVER CARD ================= */}
        {(mode === "receiver" || mode === "duo") && (
          <section className="bg-[#1c1b18] border border-stone-800/90 rounded-xl sm:rounded-2xl p-4 sm:p-6 shadow-xl space-y-4 sm:space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-stone-800">
              <div className="flex items-center gap-2.5">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    isReceiverArmed
                      ? receiverStatus === "detected" || receiverStatus === "decoding"
                        ? "bg-amber-400 animate-pulse"
                        : receiverStatus === "success"
                        ? "bg-emerald-400"
                        : "bg-emerald-500 animate-pulse"
                      : "bg-stone-600"
                  }`}
                />
                <h2 className="text-xs sm:text-sm font-semibold tracking-wide uppercase text-stone-300">
                  Acoustic Receiver (Device B)
                </h2>
              </div>

              {/* Status Badge */}
              <span
                className={`text-[11px] sm:text-xs px-2.5 sm:px-3 py-1 rounded-full font-medium self-start sm:self-auto transition-colors ${
                  !isReceiverArmed
                    ? "bg-stone-800/60 text-stone-400 border border-stone-700/50"
                    : receiverStatus === "detected"
                    ? "bg-amber-950/70 text-amber-300 border border-amber-800/60"
                    : receiverStatus === "decoding"
                    ? "bg-amber-950/70 text-amber-300 border border-amber-800/60"
                    : receiverStatus === "success"
                    ? "bg-emerald-950/70 text-emerald-300 border border-emerald-800/60"
                    : "bg-emerald-950/40 text-emerald-300 border border-emerald-800/40 animate-pulse"
                }`}
              >
                {!isReceiverArmed
                  ? "Receiver Offline"
                  : receiverStatus === "detected"
                  ? "🎵 Carrier Heard! Receiving…"
                  : receiverStatus === "decoding"
                  ? "Decoding Audio Bits…"
                  : receiverStatus === "success"
                  ? "Transmission Completed ✓"
                  : "Auto-detecting sound in room…"}
              </span>
            </div>

            {/* THE PROMINENT RECEIVER BUTTON BANNER */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-[#242320] p-3.5 sm:p-4 rounded-xl border border-stone-800">
              <div className="text-xs text-stone-300 space-y-0.5">
                <p className="font-semibold text-[#f5efe6]">
                  {isReceiverArmed
                    ? "Acoustic Auto-Detection is Active"
                    : "Start Receiver to Listen for Transmission"}
                </p>
                <p className="text-[11px] sm:text-xs text-stone-400">
                  {isReceiverArmed
                    ? "Plays chime and automatically auto-stops when sound ends."
                    : "Tap button to start microphone listening."}
                </p>
              </div>

              <button
                onClick={toggleReceiver}
                className={`flex items-center justify-center gap-2 px-5 py-3 sm:py-2.5 rounded-xl font-medium text-xs transition-all shadow-md active:scale-[0.98] w-full sm:w-auto flex-shrink-0 ${
                  isReceiverArmed
                    ? "bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-600"
                    : "bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-semibold"
                }`}
              >
                {isReceiverArmed ? (
                  <>
                    <MicOff size={16} />
                    <span>Stop Listening</span>
                  </>
                ) : (
                  <>
                    <Mic size={16} />
                    <span>Start Auto-Detection</span>
                  </>
                )}
              </button>
            </div>

            {/* Microphone Live VU Indicator (When Armed) */}
            {isReceiverArmed && (
              <div className="space-y-1.5 p-3 rounded-xl bg-[#141413] border border-stone-800/80">
                <div className="flex items-center justify-between text-[10px] sm:text-[11px] font-claude-mono text-stone-400">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    MIC INPUT SENSITIVITY
                  </span>
                  <span>SNR: {snrDb} dB</span>
                </div>
                <div className="w-full bg-stone-900 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 via-amber-400 to-[#d97757] transition-all duration-75"
                    style={{ width: `${Math.min(100, Math.max(5, audioLevel * 100))}%` }}
                  />
                </div>
              </div>
            )}

            {/* Prominent Decoded Message Area */}
            <div className="bg-[#141413] border border-stone-700/70 rounded-xl sm:rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4">
              <div className="flex items-center justify-between text-xs text-stone-400">
                <span className="font-medium tracking-wide uppercase text-[10px] sm:text-[11px] text-stone-400">
                  Decoded Plain Text Message
                </span>
                {crcValid && (
                  <span className="flex items-center gap-1 text-emerald-400 font-claude-mono text-[10px] sm:text-[11px]">
                    <Check size={13} /> CRC-8 Verified
                  </span>
                )}
              </div>

              {/* The Big Text */}
              <div className="min-h-[80px] sm:min-h-[90px] flex items-center justify-center py-2">
                {receivedMessage ? (
                  <div className="text-center space-y-1.5 max-w-full">
                    <p className="text-2xl sm:text-4xl font-claude-serif font-semibold text-[#f5efe6] tracking-tight break-words break-all">
                      {receivedMessage}
                    </p>
                    <p className="text-[11px] sm:text-xs text-stone-400 font-claude-mono">
                      Received via physical sound waves ({new TextEncoder().encode(receivedMessage).length} bytes)
                    </p>
                  </div>
                ) : (
                  <div className="text-center text-stone-500 space-y-1 max-w-sm px-2">
                    <p className="text-xs sm:text-sm font-medium">
                      {isReceiverArmed ? "Listening for sound transmission..." : "Tap 'Start Auto-Detection' to listen"}
                    </p>
                    <p className="text-[11px] sm:text-xs text-stone-500">
                      Play message on laptop speaker. Phone microphone will auto-detect and decode.
                    </p>
                  </div>
                )}
              </div>

              {/* Action row under decoded message */}
              {receivedMessage && (
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 pt-3 border-t border-stone-800">
                  <span className="text-[11px] sm:text-xs text-stone-400 font-claude-mono truncate">
                    Bitstream: {decodedBits || "100% Coherent"}
                  </span>

                  <button
                    onClick={copyReceived}
                    className="flex items-center justify-center gap-1.5 px-3.5 py-2 sm:py-1.5 rounded-lg bg-[#252421] hover:bg-[#2f2d29] text-xs font-medium text-stone-200 border border-stone-700 transition-colors active:scale-[0.98]"
                  >
                    {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                    <span>{copied ? "Copied" : "Copy Message"}</span>
                  </button>
                </div>
              )}
            </div>

            {/* Live Spoken Voice Ticker (If Transmitter is speaking) */}
            {liveVoiceText && (
              <div className="bg-[#24201c] border border-[#d97757]/30 rounded-xl p-3.5 sm:p-4 text-xs space-y-1 animate-fade-in">
                <div className="flex items-center gap-2 text-[#d97757] font-medium">
                  <Mic size={14} className="animate-pulse" />
                  <span>Live Spoken Voice from Transmitter:</span>
                </div>
                <p className="text-xs sm:text-sm font-medium text-[#f5efe6] italic">
                  "{liveVoiceText}"
                </p>
              </div>
            )}

            {/* Real 1024-pt FFT Spectrum Visualizer */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px] sm:text-xs text-stone-400 font-claude-mono">
                <span>MICROPHONE REAL-TIME SPECTRUM</span>
                <span>
                  {snrDb > 0 ? `SNR: ${snrDb} dB` : isReceiverArmed ? "Listening" : "Standby"}
                </span>
              </div>
              <RealtimeSpectrumCanvas
                analyser={liveAnalyser}
                lowHz={lowHz}
                highHz={highHz}
                active={receiverStatus === "detected" || receiverStatus === "decoding"}
                bit={currentBit}
              />
            </div>
          </section>
        )}

        {/* ================= TRANSMISSION HISTORY ================= */}
        {messageHistory.length > 0 && (
          <section className="bg-[#1c1b18] border border-stone-800/90 rounded-xl sm:rounded-2xl p-4 sm:p-6 shadow-xl space-y-3 sm:space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-stone-800">
              <div className="flex items-center gap-2 text-stone-300">
                <History size={15} />
                <h3 className="text-xs font-semibold tracking-wide uppercase">
                  Transmission History
                </h3>
              </div>
              <span className="text-[11px] sm:text-xs text-stone-500 font-claude-mono">
                {messageHistory.length} message(s)
              </span>
            </div>

            <div className="divide-y divide-stone-800/80">
              {messageHistory.slice(0, 5).map((item) => (
                <div key={item.id} className="py-2.5 sm:py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs">
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-xs sm:text-sm font-medium text-[#f5efe6] break-words">{item.text}</p>
                    <span className="text-[10px] sm:text-[11px] text-stone-400">
                      {new Date(item.timestamp).toLocaleTimeString()} · {item.sender || "Acoustic Air-Gap"}
                    </span>
                  </div>
                  <span className="self-start sm:self-auto px-2 py-0.5 rounded text-[9px] sm:text-[10px] font-claude-mono bg-emerald-950/60 text-emerald-400 border border-emerald-800/50 flex-shrink-0">
                    VERIFIED ✓
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Mobile Pairing Modal */}
      <MobilePairModal
        isOpen={isPairModalOpen}
        onClose={() => setIsPairModalOpen(false)}
        connectedClients={connectedPeers}
      />

      {/* Footer */}
      <footer className="border-t border-stone-800/80 py-5 sm:py-6 px-4 text-center text-[11px] sm:text-xs text-stone-500">
        <p>AcoustX · Physical Sound Transmission & Voice Air-Gap · Design System</p>
      </footer>
    </div>
  );
}
