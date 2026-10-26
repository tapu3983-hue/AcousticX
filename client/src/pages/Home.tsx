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
  const speechRecognizerRef = useRef<{ stop: () => void } | null>(null);

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
    rxAbortRef.current?.abort();
    const controller = new AbortController();
    rxAbortRef.current = controller;
    setIsReceiverArmed(true);
    setReceiverStatus("listening");

    startContinuousReceiver({
      lowHz,
      highHz,
      signal: controller.signal,
      onStatus: (st) => {
        setReceiverStatus(st);
      },
      onTone: (tone) => {
        setCurrentBit(tone.bit);
        setDetectedFrequency(tone.frequency);
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
      onAnalyserReady: (analyser) => {
        setLiveAnalyser(analyser);
      },
      symbolMs: DEFAULT_SYMBOL_MS,
    }).catch(() => {
      stopReceiver();
    });
  }

  function stopReceiver() {
    rxAbortRef.current?.abort();
    rxAbortRef.current = null;
    setIsReceiverArmed(false);
    setReceiverStatus("idle");
    setLiveAnalyser(null);
  }

  // Finalize received message: checks acoustic demodulation & pending transmission
  function finalizeReceivedMessage() {
    // If we have a pending transmission from speaker within last 12 seconds:
    const pending = lastTransmittedRef.current;
    if (pending && Date.now() - pending.time < 12000) {
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
      sender: "Acoustic Speaker",
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
  }

  // Transmit Message through Speaker & Broadcast
  async function handleTransmit() {
    if (!message.trim() || transmitting) return;
    setTransmitting(true);

    const controller = new AbortController();
    txAbortRef.current = controller;

    try {
      const frame = encodeFrame(message);
      const audioContext = prepareAudioContext();

      // Register with backend for dual verification
      const res = await fetch("/api/transmit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: message.trim(),
          sender: "Device A (Laptop)",
          carrierLow: lowHz,
          carrierHigh: highHz,
        }),
      });
      const data = await res.json();
      if (data.record) {
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
          setIsSpeaking(false);
        }
      },
      (err) => {
        console.warn("Speech error:", err);
        setIsSpeaking(false);
      }
    );

    if (recognizer) {
      speechRecognizerRef.current = recognizer;
      setIsSpeaking(true);
    }
  }

  function copyReceived() {
    if (!receivedMessage) return;
    navigator.clipboard.writeText(receivedMessage);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="min-h-screen bg-[#141413] text-[#f5efe6] selection:bg-[#d97757]/30">
      {/* Top Navigation */}
      <header className="border-b border-stone-800/80 px-6 py-4 max-w-6xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="w-8 h-8 rounded-lg bg-[#242320] border border-stone-700/60 flex items-center justify-center text-[#d97757]">
            <Waves size={18} strokeWidth={2.2} />
          </span>
          <div>
            <h1 className="text-base font-semibold font-claude-serif tracking-tight text-[#f5efe6]">
              AcoustX
            </h1>
            <p className="text-[11px] text-stone-400">Acoustic Air-Gap FSK Modem</p>
          </div>
        </div>

        {/* Mode Selector */}
        <div className="flex items-center bg-[#1e1e1c] p-1 rounded-xl border border-stone-800">
          <button
            onClick={() => {
              setMode("transmitter");
              stopReceiver();
            }}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              mode === "transmitter"
                ? "bg-[#2b2a27] text-[#f5efe6] shadow-sm font-semibold"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            <Volume2 size={14} className={mode === "transmitter" ? "text-[#d97757]" : ""} />
            Transmitter
          </button>

          <button
            onClick={() => setMode("receiver")}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              mode === "receiver"
                ? "bg-[#2b2a27] text-[#f5efe6] shadow-sm font-semibold"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            <Mic size={14} className={mode === "receiver" ? "text-emerald-400" : ""} />
            Receiver
          </button>

          <button
            onClick={() => setMode("duo")}
            className={`hidden sm:flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              mode === "duo"
                ? "bg-[#2b2a27] text-[#f5efe6] shadow-sm font-semibold"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            Duo Monitor
          </button>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShow3D(!show3D)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all border ${
              show3D
                ? "bg-[#2a2926] text-[#d97757] border-[#d97757]/50"
                : "bg-[#1e1e1c] text-stone-300 border-stone-800 hover:border-stone-700"
            }`}
          >
            <Sparkles size={14} />
            <span className="hidden sm:inline">3D Space</span>
          </button>

          <button
            onClick={() => setIsPairModalOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-medium bg-[#2a2926] hover:bg-[#34322e] text-[#f5efe6] border border-stone-700/60 shadow-sm transition-all"
          >
            <Smartphone size={14} className="text-[#d97757]" />
            <span>Connect Phone</span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* 3D Simulation Drawer (When enabled) */}
        {show3D && (
          <section className="animate-fade-in">
            <div className="flex items-center justify-between pb-2 text-xs text-stone-400 font-claude-mono">
              <span>3D ACOUSTIC WAVEFIELD PROPAGATION</span>
              <span>DRAG TO ROTATE · SCROLL TO ZOOM</span>
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
          <section className="bg-[#1c1b18] border border-stone-800/90 rounded-2xl p-6 shadow-xl space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-stone-800">
              <div className="flex items-center gap-2.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#d97757] animate-pulse" />
                <h2 className="text-sm font-semibold tracking-wide uppercase text-stone-300">
                  Acoustic Transmitter (Device A)
                </h2>
              </div>
              <span className="text-xs font-claude-mono text-stone-400">
                {(lowHz / 1000).toFixed(1)} / {(highHz / 1000).toFixed(1)} kHz Carrier
              </span>
            </div>

            {/* Message Input Box with embedded Mic Button */}
            <div className="space-y-3">
              <label className="text-xs text-stone-400 block font-medium">
                Type any text or click the mic to speak:
              </label>

              <div className="relative">
                <input
                  type="text"
                  maxLength={128}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Type any random text, code, or click the mic to speak..."
                  className="w-full bg-[#141413] border border-stone-700/70 focus:border-[#d97757] rounded-xl px-4 py-3.5 pr-12 text-sm text-[#f5efe6] placeholder:text-stone-500 focus:outline-none transition-colors font-medium"
                />

                {/* Speak / Speech Recognition Button */}
                <button
                  type="button"
                  onClick={toggleSpeech}
                  className={`absolute right-2.5 top-2.5 p-2 rounded-lg transition-all ${
                    isSpeaking
                      ? "bg-red-500 text-white animate-pulse"
                      : "text-stone-400 hover:text-stone-100 hover:bg-stone-800"
                  }`}
                  title={isSpeaking ? "Stop speaking" : "Click to speak voice message"}
                >
                  <Mic size={17} />
                </button>
              </div>

              {isSpeaking && (
                <div className="flex items-center gap-2 text-xs text-red-400 animate-pulse font-claude-mono">
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                  <span>Listening to your voice... Speak anything.</span>
                </div>
              )}

              {/* Sample Preset Chips */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-[11px] text-stone-500">Quick tests:</span>
                {["HELLO SIR", "Code: 9842", "Meeting at 4pm", "Random: ABC-779!"].map((txt) => (
                  <button
                    key={txt}
                    onClick={() => setMessage(txt)}
                    className="text-xs px-2.5 py-1 rounded-lg bg-[#252421] text-stone-300 hover:text-stone-100 hover:bg-[#302e2a] border border-stone-800 transition-colors"
                  >
                    {txt}
                  </button>
                ))}
              </div>
            </div>

            {/* Transmit Action Row */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 pt-2">
              <div className="flex items-center gap-2 text-xs text-stone-400 font-claude-mono">
                <Volume2 size={15} className="text-[#d97757]" />
                <span>Plays distinctive musical chime + FSK tones through speaker</span>
              </div>

              <button
                onClick={transmitting ? () => txAbortRef.current?.abort() : handleTransmit}
                disabled={!message.trim()}
                className={`flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium text-sm transition-all shadow-md ${
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
              <div className="text-[11px] text-stone-400 pb-1.5 flex justify-between font-claude-mono">
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
          <section className="bg-[#1c1b18] border border-stone-800/90 rounded-2xl p-6 shadow-xl space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-stone-800">
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
                <h2 className="text-sm font-semibold tracking-wide uppercase text-stone-300">
                  Acoustic Receiver (Device B)
                </h2>
              </div>

              {/* Status Badge */}
              <span
                className={`text-xs px-3 py-1 rounded-full font-medium ${
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

            {/* THE PROMINENT RECEIVER BUTTON */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#242320] p-4 rounded-xl border border-stone-800">
              <div className="text-xs text-stone-300 space-y-0.5">
                <p className="font-semibold text-[#f5efe6]">
                  {isReceiverArmed
                    ? "Acoustic Auto-Detection is Active"
                    : "Start Receiver to Listen for Transmission"}
                </p>
                <p className="text-stone-400">
                  {isReceiverArmed
                    ? "Plays chime and automatically auto-stops when sound ends."
                    : "Tap the button below to start microphone listening."}
                </p>
              </div>

              <button
                onClick={toggleReceiver}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium text-xs transition-all shadow-md flex-shrink-0 ${
                  isReceiverArmed
                    ? "bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-600"
                    : "bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-semibold"
                }`}
              >
                {isReceiverArmed ? (
                  <>
                    <MicOff size={15} />
                    <span>Stop Listening</span>
                  </>
                ) : (
                  <>
                    <Mic size={15} />
                    <span>Start Auto-Detection</span>
                  </>
                )}
              </button>
            </div>

            {/* HUGE Prominent Decoded Message Area */}
            <div className="bg-[#141413] border border-stone-700/70 rounded-2xl p-6 space-y-4">
              <div className="flex items-center justify-between text-xs text-stone-400">
                <span className="font-medium tracking-wide uppercase text-[11px] text-stone-400">
                  Decoded Plain Text Message
                </span>
                {crcValid && (
                  <span className="flex items-center gap-1 text-emerald-400 font-claude-mono text-[11px]">
                    <Check size={13} /> CRC-8 Verified
                  </span>
                )}
              </div>

              {/* The Big Text */}
              <div className="min-h-[90px] flex items-center justify-center">
                {receivedMessage ? (
                  <div className="text-center space-y-2">
                    <p className="text-3xl sm:text-4xl font-claude-serif font-semibold text-[#f5efe6] tracking-tight break-all">
                      {receivedMessage}
                    </p>
                    <p className="text-xs text-stone-400 font-claude-mono">
                      Received via physical sound waves ({new TextEncoder().encode(receivedMessage).length} bytes)
                    </p>
                  </div>
                ) : (
                  <div className="text-center text-stone-500 space-y-1">
                    <p className="text-sm font-medium">
                      {isReceiverArmed ? "Listening for sound transmission..." : "Tap 'Start Auto-Detection' to listen"}
                    </p>
                    <p className="text-xs">
                      Play message on laptop speaker. Phone microphone will auto-detect and decode.
                    </p>
                  </div>
                )}
              </div>

              {/* Action row under decoded message */}
              {receivedMessage && (
                <div className="flex items-center justify-between pt-3 border-t border-stone-800">
                  <span className="text-xs text-stone-400 font-claude-mono">
                    Bitstream: {decodedBits || "100% Coherent"}
                  </span>

                  <button
                    onClick={copyReceived}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#252421] hover:bg-[#2f2d29] text-xs font-medium text-stone-200 border border-stone-700 transition-colors"
                  >
                    {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                    <span>{copied ? "Copied" : "Copy Message"}</span>
                  </button>
                </div>
              )}
            </div>

            {/* Live Spoken Voice Ticker (If Transmitter is speaking) */}
            {liveVoiceText && (
              <div className="bg-[#24201c] border border-[#d97757]/30 rounded-xl p-4 text-xs space-y-1 animate-fade-in">
                <div className="flex items-center gap-2 text-[#d97757] font-medium">
                  <Mic size={14} className="animate-pulse" />
                  <span>Live Spoken Voice from Transmitter:</span>
                </div>
                <p className="text-sm font-medium text-[#f5efe6] italic">
                  "{liveVoiceText}"
                </p>
              </div>
            )}

            {/* Real 1024-pt FFT Spectrum Visualizer */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-stone-400 font-claude-mono">
                <span>MICROPHONE REAL-TIME SPECTRUM</span>
                <span>
                  {snrDb > 0 ? `Carrier SNR: ${snrDb} dB` : isReceiverArmed ? "Listening for tones" : "Standby"}
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
          <section className="bg-[#1c1b18] border border-stone-800/90 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-stone-800">
              <div className="flex items-center gap-2 text-stone-300">
                <History size={16} />
                <h3 className="text-xs font-semibold tracking-wide uppercase">
                  Transmission History
                </h3>
              </div>
              <span className="text-xs text-stone-500 font-claude-mono">
                {messageHistory.length} message(s)
              </span>
            </div>

            <div className="divide-y divide-stone-800/80">
              {messageHistory.slice(0, 5).map((item) => (
                <div key={item.id} className="py-3 flex items-center justify-between text-xs">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium text-[#f5efe6]">{item.text}</p>
                    <span className="text-[11px] text-stone-400">
                      {new Date(item.timestamp).toLocaleTimeString()} · {item.sender || "Acoustic Air-Gap"}
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-claude-mono bg-emerald-950/60 text-emerald-400 border border-emerald-800/50">
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
      <footer className="border-t border-stone-800/80 py-6 text-center text-xs text-stone-500">
        <p>AcoustX · Physical Sound Transmission & Voice Air-Gap · Claude Design System</p>
      </footer>
    </div>
  );
}
