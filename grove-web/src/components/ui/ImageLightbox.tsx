import { useState, useRef, useCallback, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Minimize2 } from "lucide-react";

interface ImageLightboxProps {
  imageUrl?: string | null;
  svgContent?: string | null;
  onClose: () => void;
}

export function ImageLightbox({ imageUrl, svgContent, onClose }: ImageLightboxProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  const handleClose = useCallback(() => { onClose(); reset(); }, [onClose, reset]);

  // Reset view whenever the content changes
  useEffect(() => { reset(); }, [imageUrl, svgContent, reset]);

  // ESC to close
  useEffect(() => {
    if (!imageUrl && !svgContent) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); handleClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [imageUrl, svgContent, handleClose]);

  return (
    <AnimatePresence>
      {(imageUrl || svgContent) && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm cursor-pointer select-none"
          onClick={handleClose}
          onWheel={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.metaKey || e.ctrlKey) {
              const delta = e.deltaY > 0 ? -0.15 : 0.15;
              setZoom((z) => Math.min(10, Math.max(0.2, z + delta * z)));
            } else if (zoom > 1) {
              setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
            }
          }}
          onMouseDown={(e) => {
            if (zoom <= 1) return;
            e.preventDefault();
            panningRef.current = true;
            panStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
          }}
          onMouseMove={(e) => {
            if (!panningRef.current) return;
            const dx = e.clientX - panStartRef.current.x;
            const dy = e.clientY - panStartRef.current.y;
            setPan({ x: panStartRef.current.panX + dx, y: panStartRef.current.panY + dy });
          }}
          onMouseUp={() => { panningRef.current = false; }}
          onMouseLeave={() => { panningRef.current = false; }}
        >
          {/* Close button */}
          <button
            onClick={(e) => { e.stopPropagation(); handleClose(); }}
            className="absolute top-4 right-4 w-9 h-9 rounded-full bg-black/50 text-white/80 hover:text-white hover:bg-black/70 flex items-center justify-center transition-colors z-10"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Zoom reset button */}
          {zoom > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); reset(); }}
              className="absolute top-4 left-4 h-9 px-3 rounded-full bg-black/50 text-white/80 hover:text-white hover:bg-black/70 flex items-center justify-center gap-1.5 text-xs font-medium transition-colors z-10"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              {Math.round(zoom * 100)}%
            </button>
          )}

          {/* Content */}
          <div
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transition: panningRef.current ? "none" : "transform 0.15s ease-out",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {imageUrl ? (
              <motion.img
                key={imageUrl}
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                transition={{ duration: 0.15 }}
                src={imageUrl}
                className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl cursor-default"
                alt=""
              />
            ) : svgContent ? (
              <motion.div
                key="svg"
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="w-[90vw] h-[90vh] flex items-center justify-center rounded-lg bg-[var(--color-bg-secondary)] shadow-2xl cursor-default [&_svg]:max-w-[88vw] [&_svg]:max-h-[88vh]"
                dangerouslySetInnerHTML={{ __html: svgContent }}
              />
            ) : null}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
