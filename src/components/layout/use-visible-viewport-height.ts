"use client";

import { useEffect } from "react";

const VAR = "--app-viewport-height";

/**
 * Keep `--app-viewport-height` equal to the visible viewport while `enabled`.
 *
 * Full-height screens (the inbox) size themselves to it so the reply box stays
 * on screen when a phone keyboard opens. Chromium on Android already shrinks
 * the layout viewport (the root `interactive-widget=resizes-content` viewport
 * setting), but iOS Safari only shrinks the visual viewport and leaves `dvh`
 * unchanged, which pushed the composer under the keyboard.
 */
export function useVisibleViewportHeight(enabled: boolean) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return;
    const root = document.documentElement;

    const update = () => {
      // Pinch-zoom also shrinks the visual viewport; the layout must not follow it.
      if (Math.abs(viewport.scale - 1) > 0.01) {
        root.style.removeProperty(VAR);
        return;
      }
      root.style.setProperty(VAR, `${Math.round(viewport.height)}px`);
      // iOS pans the page up to reveal a focused field; the layout now fits
      // the visible area, so put it back where it belongs.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };

    update();
    viewport.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      root.style.removeProperty(VAR);
    };
  }, [enabled]);
}
