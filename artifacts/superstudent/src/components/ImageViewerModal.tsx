import React, { useState, useEffect, useRef } from "react";
import {
  X,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Maximize2,
  Minimize2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  Image as ImageIcon,
  Expand,
} from "lucide-react";
import { LangKey } from "../types";
import { Spinner } from "./Atoms";

export interface ImageCollectionItem {
  url: string;
  title?: string;
  alt?: string;
  fallbackUrl?: string;
}

interface ImageViewerModalProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  title?: string;
  alt?: string;
  fallbackUrl?: string;
  collection?: ImageCollectionItem[];
  initialIndex?: number;
  lang?: LangKey;
}

export function ImageViewerModal({
  isOpen,
  onClose,
  imageUrl,
  title,
  alt = "Image reader preview",
  fallbackUrl,
  collection,
  initialIndex = 0,
  lang = "ar",
}: ImageViewerModalProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const [usedFallback, setUsedFallback] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // If a collection is provided, derive current item
  const hasCollection = collection && collection.length > 1;
  const currentItem = hasCollection ? collection[currentIndex] : null;
  const activeUrl = currentItem
    ? (usedFallback && currentItem.fallbackUrl ? currentItem.fallbackUrl : currentItem.url)
    : (usedFallback && fallbackUrl ? fallbackUrl : imageUrl);
  const activeTitle = currentItem?.title || title || (lang === "ar" ? "معاينة الصورة" : "Aperçu de l'image");

  useEffect(() => {
    if (!isOpen) {
      setScale(1);
      setRotation(0);
      setIsLoading(true);
      setIsError(false);
      setUsedFallback(false);
      setRetryCount(0);
      setIsFullscreen(false);
      return;
    }

    setIsLoading(true);
    setIsError(false);
    setScale(1);
    setRotation(0);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "+" || e.key === "=") {
        handleZoomIn();
      } else if (e.key === "-") {
        handleZoomOut();
      } else if (e.key === "0") {
        handleResetZoom();
      } else if (e.key === "ArrowRight" && hasCollection) {
        handleNext();
      } else if (e.key === "ArrowLeft" && hasCollection) {
        handlePrev();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen, currentIndex, retryCount, usedFallback, onClose]);

  if (!isOpen) return null;

  function handleZoomIn() {
    setScale((prev) => Math.min(prev + 0.25, 4));
  }

  function handleZoomOut() {
    setScale((prev) => Math.max(prev - 0.25, 0.5));
  }

  function handleResetZoom() {
    setScale(1);
    setRotation(0);
  }

  function handleFitWidth() {
    setScale(1.5);
  }

  function handleRotate() {
    setRotation((prev) => (prev + 90) % 360);
  }

  function handleNext() {
    if (!collection) return;
    setCurrentIndex((prev) => (prev + 1) % collection.length);
    setUsedFallback(false);
  }

  function handlePrev() {
    if (!collection) return;
    setCurrentIndex((prev) => (prev - 1 + collection.length) % collection.length);
    setUsedFallback(false);
  }

  function handleRetry() {
    setIsLoading(true);
    setIsError(false);
    setRetryCount((prev) => prev + 1);
  }

  function handleImageError() {
    setIsLoading(false);
    const availableFallback = currentItem?.fallbackUrl || fallbackUrl;
    if (availableFallback && !usedFallback) {
      setUsedFallback(true);
      setIsLoading(true);
    } else {
      setIsError(true);
      setErrorMessage(
        lang === "ar"
          ? "تعذر تحميل الصورة. قد يكون مزود الاستضافة متوقفاً مؤقتاً أو الرابط منتهي الصلاحية."
          : "Impossible de charger l'image. Le serveur d'hébergement est peut-être indisponible."
      );
    }
  }

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-950/90 backdrop-blur-md animate-in fade-in duration-200"
    >
      <div
        className={`bg-slate-900 border border-slate-700/80 rounded-2xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden transition-all duration-200 ${
          isFullscreen
            ? "w-full h-full rounded-none sm:rounded-none"
            : "w-full max-w-5xl h-[90vh] max-h-[850px]"
        }`}
      >
        {/* Top Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 bg-slate-950/90 border-b border-slate-800 gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center shrink-0">
              <ImageIcon size={17} />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-white truncate max-w-md">
                {activeTitle}
              </h3>
              <p className="text-[10px] text-slate-400">
                {hasCollection
                  ? `${currentIndex + 1} / ${collection.length} • `
                  : ""}
                {Math.round(scale * 100)}% • {rotation}°
                {usedFallback && (
                  <span className="text-amber-400 ml-1">
                    ({lang === "ar" ? "نسخة احتياطية" : "Copie de secours"})
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* Controls Bar */}
          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
            <button
              type="button"
              onClick={handleZoomIn}
              disabled={scale >= 4}
              className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1 transition-colors disabled:opacity-40 cursor-pointer"
              title="تكبير (+)"
            >
              <ZoomIn size={14} />
              <span className="hidden md:inline">+</span>
            </button>

            <button
              type="button"
              onClick={handleZoomOut}
              disabled={scale <= 0.5}
              className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1 transition-colors disabled:opacity-40 cursor-pointer"
              title="تصغير (-)"
            >
              <ZoomOut size={14} />
              <span className="hidden md:inline">-</span>
            </button>

            <button
              type="button"
              onClick={handleResetZoom}
              className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors cursor-pointer"
              title="إعادة ضبط (100%)"
            >
              100%
            </button>

            <button
              type="button"
              onClick={handleFitWidth}
              className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors cursor-pointer hidden sm:flex items-center gap-1"
              title="ملائمة العرض"
            >
              <Expand size={13} />
              <span className="hidden lg:inline">{lang === "ar" ? "عرض كامل" : "Ajuster"}</span>
            </button>

            <button
              type="button"
              onClick={handleRotate}
              className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer"
              title="تدوير (90°)"
            >
              <RotateCw size={14} />
            </button>

            <button
              type="button"
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer hidden sm:flex"
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

        {/* Main Viewer Body */}
        <div className="relative flex-1 bg-[#070D12] overflow-auto flex items-center justify-center p-4 select-none">
          {/* Loading state */}
          {isLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-950/80 gap-3">
              <div className="w-10 h-10 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
                <Spinner size={22} />
              </div>
              <p className="text-xs font-bold text-slate-300">
                {lang === "ar" ? "جارٍ تحميل الصورة بجودة عالية..." : "Chargement de l'image..."}
              </p>
            </div>
          )}

          {/* Error fallback state */}
          {isError && (
            <div className="max-w-md p-6 rounded-2xl bg-slate-900 border border-red-500/30 text-center space-y-3 z-10">
              <div className="w-12 h-12 rounded-2xl bg-red-500/20 text-red-400 border border-red-500/30 flex items-center justify-center mx-auto">
                <AlertTriangle size={24} />
              </div>
              <h4 className="text-sm font-bold text-white">
                {lang === "ar" ? "تعذر عرض الصورة" : "Erreur de chargement"}
              </h4>
              <p className="text-xs text-slate-400 leading-relaxed">
                {errorMessage}
              </p>
              <div className="pt-2 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={handleRetry}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-2 shadow-md transition-all cursor-pointer"
                >
                  <RefreshCw size={13} />
                  <span>{lang === "ar" ? "إعادة المحاولة" : "Réessayer"}</span>
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors cursor-pointer"
                >
                  {lang === "ar" ? "إغلاق" : "Fermer"}
                </button>
              </div>
            </div>
          )}

          {/* Render Image */}
          {!isError && (
            <div
              className="transition-transform duration-150 ease-out flex items-center justify-center max-w-full max-h-full"
              style={{
                transform: `scale(${scale}) rotate(${rotation}deg)`,
                transformOrigin: "center center",
              }}
            >
              <img
                key={`${activeUrl}-${retryCount}`}
                src={activeUrl}
                alt={alt}
                onLoad={() => setIsLoading(false)}
                onError={handleImageError}
                className="max-w-full max-h-[72vh] object-contain rounded-lg shadow-2xl transition-opacity duration-200"
                style={{ opacity: isLoading ? 0 : 1 }}
              />
            </div>
          )}

          {/* Collection Next / Prev arrows */}
          {hasCollection && (
            <>
              <button
                type="button"
                onClick={handlePrev}
                className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-slate-900/80 hover:bg-slate-800 text-white border border-slate-700/80 flex items-center justify-center shadow-lg transition-all cursor-pointer"
                aria-label="Previous"
              >
                <ChevronLeft size={20} />
              </button>
              <button
                type="button"
                onClick={handleNext}
                className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-slate-900/80 hover:bg-slate-800 text-white border border-slate-700/80 flex items-center justify-center shadow-lg transition-all cursor-pointer"
                aria-label="Next"
              >
                <ChevronRight size={20} />
              </button>
            </>
          )}
        </div>

        {/* Bottom Help Bar */}
        <div className="px-4 py-2 bg-slate-950/95 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
          <span>
            {lang === "ar"
              ? "قارئ الصور المدمج • استخدم عجلة الفأرة أو الأزرار للتكبير • Esc للإغلاق"
              : "Lecteur d'images intégré • Utilisez la molette pour zoomer • Esc pour fermer"}
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleResetZoom}
              className="text-amber-400 hover:text-amber-300 font-semibold transition-colors"
            >
              {lang === "ar" ? "الحجم الطبيعي" : "Taille normale"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
