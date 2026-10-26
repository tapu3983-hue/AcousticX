import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy, Check, Smartphone, X, Wifi, Globe, Sparkles } from "lucide-react";

interface MobilePairModalProps {
  isOpen: boolean;
  onClose: () => void;
  connectedClients?: number;
}

export default function MobilePairModal({ isOpen, onClose, connectedClients = 0 }: MobilePairModalProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [selectedUrl, setSelectedUrl] = useState<string>("");
  const [availableUrls, setAvailableUrls] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isOpen) return;

    async function loadNetworkInfo() {
      setLoading(true);
      try {
        const currentOrigin = window.location.origin;
        const isNgrok = currentOrigin.includes("ngrok") || currentOrigin.includes("loca.lt");

        const urls: string[] = [];

        // If accessed through ngrok or public domain, place that first!
        if (isNgrok) {
          urls.push(currentOrigin);
        }

        try {
          const res = await fetch("/api/network-info");
          const data = await res.json();
          const port = data.port || window.location.port || 3000;
          if (Array.isArray(data.ips)) {
            for (const ip of data.ips) {
              const lanUrl = `http://${ip}:${port}`;
              if (!urls.includes(lanUrl)) urls.push(lanUrl);
            }
          }
        } catch {
          /* ignore */
        }

        if (!urls.includes(currentOrigin)) {
          urls.push(currentOrigin);
        }

        setAvailableUrls(urls);
        const bestUrl = urls[0];
        setSelectedUrl(bestUrl);

        const qr = await QRCode.toDataURL(bestUrl, {
          width: 260,
          margin: 1.5,
          color: {
            dark: "#f5efe6",
            light: "#181816",
          },
        });
        setQrDataUrl(qr);
      } catch {
        const fallback = window.location.origin;
        setSelectedUrl(fallback);
        setAvailableUrls([fallback]);
      } finally {
        setLoading(false);
      }
    }

    loadNetworkInfo();
  }, [isOpen]);

  async function handleSelectUrl(url: string) {
    setSelectedUrl(url);
    try {
      const qr = await QRCode.toDataURL(url, {
        width: 260,
        margin: 1.5,
        color: {
          dark: "#f5efe6",
          light: "#181816",
        },
      });
      setQrDataUrl(qr);
    } catch {
      /* ignore */
    }
  }

  function copyToClipboard() {
    if (!selectedUrl) return;
    navigator.clipboard.writeText(selectedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-lg rounded-2xl bg-[#1a1917] border border-stone-700/60 p-6 shadow-2xl text-[#f5efe6]">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-stone-800">
          <div className="flex items-center gap-3">
            <span className="p-2 rounded-xl bg-[#262422] text-[#d97757] border border-stone-800">
              <Smartphone size={20} />
            </span>
            <div>
              <h2 className="text-base font-medium font-claude-serif tracking-tight text-[#f5efe6]">
                Connect Mobile Device
              </h2>
              <p className="text-xs text-stone-400">Scan to open on your smartphone</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-stone-800 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="py-5 space-y-5">
          <div className="flex flex-col sm:flex-row items-center gap-6 bg-[#21201d] p-5 rounded-xl border border-stone-800/80">
            {/* QR Code Container */}
            <div className="relative flex-shrink-0 w-[170px] h-[170px] rounded-xl overflow-hidden border border-stone-700/60 bg-[#181816] flex items-center justify-center shadow-lg">
              {loading ? (
                <span className="text-xs text-stone-400 animate-pulse">Generating QR…</span>
              ) : qrDataUrl ? (
                <img src={qrDataUrl} alt="Pairing QR Code" className="w-full h-full object-contain p-2" />
              ) : null}
            </div>

            {/* Simple Step Guide */}
            <div className="space-y-3 text-xs text-stone-300">
              <div className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-[#d97757]/20 text-[#d97757] flex items-center justify-center text-[11px] font-medium flex-shrink-0 mt-0.5">
                  1
                </span>
                <span>Open your phone camera and scan this QR code.</span>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-[#d97757]/20 text-[#d97757] flex items-center justify-center text-[11px] font-medium flex-shrink-0 mt-0.5">
                  2
                </span>
                <span>
                  On phone: Select <strong className="text-emerald-400">Receiver</strong>.
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-[#d97757]/20 text-[#d97757] flex items-center justify-center text-[11px] font-medium flex-shrink-0 mt-0.5">
                  3
                </span>
                <span>
                  On laptop: Speak or type a message and press <strong className="text-[#d97757]">Transmit</strong>.
                </span>
              </div>
              <p className="text-[11px] text-stone-400 pt-1">
                Sound travels through room air from laptop speaker to phone mic.
              </p>
            </div>
          </div>

          {/* URL selector and copy */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-stone-400">
              <span>Direct Link:</span>
              {availableUrls.length > 1 && (
                <div className="flex gap-2">
                  {availableUrls.map((u, i) => (
                    <button
                      key={u}
                      onClick={() => handleSelectUrl(u)}
                      className={`text-[10px] px-2 py-0.5 rounded ${
                        selectedUrl === u ? "bg-[#d97757] text-white" : "bg-stone-800 text-stone-400"
                      }`}
                    >
                      {u.includes("ngrok") ? "ngrok" : `IP ${i + 1}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1 flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-[#21201d] border border-stone-800 text-xs text-stone-300 font-claude-mono truncate">
                <Globe size={14} className="text-[#d97757] flex-shrink-0" />
                <span className="truncate">{selectedUrl}</span>
              </div>
              <button
                onClick={copyToClipboard}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#2b2926] hover:bg-[#34322e] text-[#f5efe6] text-xs font-medium transition-colors border border-stone-700/60 flex-shrink-0"
              >
                {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-stone-800 flex justify-between items-center text-xs text-stone-400">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            {connectedClients > 0 ? `${connectedClients} device(s) connected` : "Ready for connection"}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-xs text-stone-200 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
