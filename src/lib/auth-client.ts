"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Same-origin auth client (no baseURL): works on localhost, LAN hosts and
 * production domains alike; better-auth resolves the API relative to the
 * current origin.
 */
export const authClient = createAuthClient();
