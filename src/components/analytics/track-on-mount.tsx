"use client";

import { useEffect, useRef } from "react";

import { track, type AnalyticsData, type AnalyticsEvent } from "@/lib/analytics";

/**
 * Sends one analytics event when it first renders. Lets server pages record
 * outcomes they learn from the URL (a Stripe return, an onboarding error)
 * after the query string itself is stripped from the page view.
 */
export function TrackOnMount({ event, data }: { event: AnalyticsEvent; data?: AnalyticsData }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    // Umami loads deferred; give it a moment on a fresh document.
    const send = () => {
      if (sent.current) return;
      if (!(window as unknown as { umami?: unknown }).umami) return;
      sent.current = true;
      track(event, data);
    };
    send();
    if (sent.current) return;
    const timer = window.setInterval(send, 250);
    const stop = window.setTimeout(() => window.clearInterval(timer), 5000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per mount
  }, []);
  return null;
}
