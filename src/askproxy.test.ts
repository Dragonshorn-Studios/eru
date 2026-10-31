import { describe, expect, it } from "vitest";
import { isAskEventStream, proxyPathAllowed } from "./askproxy.js";

describe("ask proxy allowlist", () => {
  it("treats OC1 and OC2 event streams as timeout-exempt", () => {
    expect(isAskEventStream("/event")).toBe(true);
    expect(isAskEventStream("/api/event")).toBe(true);
    expect(isAskEventStream("/api/session")).toBe(false);
    expect(isAskEventStream("/session")).toBe(false);
    expect(proxyPathAllowed("/api/event")).toBe(true);
    expect(proxyPathAllowed("/event")).toBe(true);
  });
});
