import { describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import proxy from "@/proxy";

function makeRequest(path: string) {
  return new NextRequest(new URL(`http://localhost:3000${path}`));
}

describe("proxy", () => {
  it.each(["/", "/login", "/register", "/invite/abc"])("lets the public entry %s through", (path) => {
    const response = proxy(makeRequest(path));
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("redirects unauthenticated app routes to login, keeping the destination", () => {
    const response = proxy(makeRequest("/settings/team"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fsettings%2Fteam");
  });

  it("passes protected routes through with a session cookie", () => {
    const request = makeRequest("/inbox");
    request.cookies.set("better-auth.session_token", "t");
    const response = proxy(request);
    expect(response).toBeInstanceOf(NextResponse);
    expect(response.headers.get("location")).toBeNull();
  });
});
