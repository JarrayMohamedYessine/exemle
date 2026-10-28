import React, { useState, useEffect } from "react";
import {
  X,
  ExternalLink,
  RotateCw,
  Maximize2,
  Minimize2,
  FileText,
  AlertTriangle,
  Download,
} from "lucide-react";
import { LangKey } from "../types";
import { Spinner } from "./Atoms";

interface GooglePdfViewerModalProps {
  isOpen: boolean;
  onClose: () => void;
  pdfUrl: string;
  title: string;
  isCorrige?: boolean;
  lang?: LangKey;
}

export function GooglePdfViewerModal({
  isOpen,
  onClose,
  pdfUrl,
  title,
  isCorrige = false,
  lang = "ar",
}: GooglePdfViewerModalProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasTimeoutWarning, setHasTimeoutWarning] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Validate URL protocol
  const isHttps = pdfUrl.startsWith("https://") || pdfUrl.startsWith("http://");

  // Construct official Google Docs Viewer embedded URL
  const googleViewerUrl = isHttps
    ? `https://docs.google.com/gview?embedded=true&url=${encodeURIComponent(pdfUrl)}`
    : pdfUrl;

  useEffect(() => {
    if (!isOpen) {
      setIsLoading(true);
      setHasTimeoutWarning(false);
      setIsFullscreen(false);
      return;
    }

    setIsLoading(true);
    setHasTimeoutWarning(false);

    // Timeout alert after 8 seconds if Google Viewer is slow to respond or blocked
    const timer = setTimeout(() => {
      setHasTimeoutWarning(true);
    }, 8000);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    // Lock background scroll
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen, iframeKey, onClose]);

  if (!isOpen) return null;

  function handleReload() {
    setIsLoading(true);
    setHasTimeoutWarning(false);
    setIframeKey((prev) => prev + 1);
  }

  function handleOpenOriginal() {
    if (!pdfUrl) return;
    const win = window.open(pdfUrl, "_blank", "noopener,noreferrer");
    if (!win) {
      const a = document.createElement("a");
      a.href = pdfUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className={`bg-slate-900 border border-slate-700/80 rounded-2xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden transition-all duration-200 ${
          isFullscreen
            ? "w-full h-full rounded-none sm:rounded-none"
            : "w-full max-w-5xl h-[92vh] max-h-[900px]"
        }`}
      >
        {/* Top Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 bg-slate-950/90 border-b border-slate-800 gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                isCorrige
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                  : "bg-indigo-500/20 text-indigo-400 border border-indigo-500/30"
              }`}
            >
              <FileText size={17} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider shrink-0 ${
                    isCorrige
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                      : "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                  }`}
                >
                  {isCorrige
                    ? lang === "ar"
                      ? "الإصلاح الرسمي"
                      : "Correction"
                    : lang === "ar"
                    ? "موضوع الامتحان"
                    : "Sujet"}
                </span>
                <h3 className="text-sm font-bold text-white truncate max-w-md">
                  {title || (lang === "ar" ? "معاينة الوثيقة" : "Aperçu du document")}
                </h3>
              </div>
              <p className="text-[10px] text-slate-400 truncate">
                Google Docs PDF Viewer • {pdfUrl ? new URL(pdfUrl).hostname : "SuperStudent"}
              </p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {/* Primary Open Original PDF Fallback Button */}
            <button
              type="button"
              onClick={handleOpenOriginal}
              className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-indigo-600/20 transition-all cursor-pointer"
              title={
                lang === "ar"
                  ? "فتح ملف PDF الأصلي مباشرة في تبويب جديد"
                  : "Ouvrir le PDF original"
              }
            >
              <ExternalLink size={13} />
              <span className="hidden sm:inline">
                {lang === "ar" ? "فتح ملف PDF الأصلي" : "Ouvrir PDF original"}
              </span>
            </button>

            <button
              type="button"
              onClick={handleReload}
              className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
              title={lang === "ar" ? "إعادة تحميل القارئ" : "Recharger le lecteur"}
            >
              <RotateCw size={14} className={isLoading ? "animate-spin" : ""} />
              <span className="hidden md:inline">{lang === "ar" ? "تحديث" : "Actualiser"}</span>
            </button>

            <button
              type="button"
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer hidden sm:flex"
              title={isFullscreen ? "تصغير" : "ملء الشاشة"}
            >
              {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-xl bg-slate-800/80 hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition-colors cursor-pointer"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Fallback timeout warning banner */}
        {hasTimeoutWarning && isLoading && (
          <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 flex items-center justify-between text-xs text-amber-200">
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} className="text-amber-400 shrink-0" />
              <span>
                {lang === "ar"
                  ? "يبدو أن قارئ Google يستغرق وقتاً أطول من المعتاد. يمكنك النقر فوق «فتح ملف PDF الأصلي» لفتحه مباشرة."
                  : "Le lecteur Google prend du temps. Vous pouvez cliquer sur « Ouvrir PDF original »."}
              </span>
            </div>
            <button
              type="button"
              onClick={handleOpenOriginal}
              className="underline font-bold hover:text-white shrink-0 ml-2"
            >
              {lang === "ar" ? "فتح الآن" : "Ouvrir maintenant"}
            </button>
          </div>
        )}

        {/* Viewer Container */}
        <div className="relative flex-1 bg-slate-950 w-full h-full overflow-hidden">
          {/* Loading spinner overlay */}
          {isLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-950/90 text-center p-6 gap-3">
              <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                <Spinner size={24} />
              </div>
              <p className="text-xs font-bold text-slate-200">
                {lang === "ar" ? "جارٍ تحميل وثيقة PDF عبر Google Viewer..." : "Chargement du document PDF via Google..."}
              </p>
              <p className="text-[11px] text-slate-400 max-w-sm leading-relaxed">
                {lang === "ar"
                  ? "يتم جلب الملف الأصلي وتنسيق الصفحات للقراءة المباشرة دون استهلاك سعة جهازك."
                  : "Affichage direct et fluide des pages sans téléchargement préalable."}
              </p>
            </div>
          )}

          {/* Google PDF Embedded Iframe */}
          <iframe
            key={iframeKey}
            src={googleViewerUrl}
            title={`Google PDF Viewer - ${title}`}
            onLoad={() => setIsLoading(false)}
            className="w-full h-full border-0"
            allow="fullscreen"
          />
        </div>

        {/* Bottom Status Bar */}
        <div className="px-4 py-2 bg-slate-950/95 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>
              {lang === "ar"
                ? "قارئ Google الرسمي المدمج • اضغط Esc للإغلاق"
                : "Lecteur Google officiel • Appuyez sur Esc pour fermer"}
            </span>
          </div>

          <button
            type="button"
            onClick={handleOpenOriginal}
            className="text-indigo-400 hover:text-indigo-300 font-semibold flex items-center gap-1 transition-colors"
          >
            <span>{lang === "ar" ? "تنزيل / فتح الملف الأصلي" : "Télécharger / Ouvrir"}</span>
            <ExternalLink size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}
