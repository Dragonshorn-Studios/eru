import { describe, expect, it } from "vitest";
import { isAskEventStream, pinWorkspaceQuery, proxyPathAllowed, unwrapOcJson, withSessionLocation } from "./askproxy.js";

describe("ask proxy allowlist", () => {
  it("treats OC1 and OC2 event streams as timeout-exempt", () => {
    expect(isAskEventStream("/event")).toBe(true);
    expect(isAskEventStream("/api/event")).toBe(true);
    expect(isAskEventStream("/api/session")).toBe(false);
    expect(isAskEventStream("/session")).toBe(false);
    const url = new URL("http://opencode.local/api/session?directory=/etc&location%5Bdirectory%5D=/etc");
    pinWorkspaceQuery(url, "/data/ask/thread");
    expect(url.searchParams.get("directory")).toBe("/data/ask/thread");
    expect(url.searchParams.get("location[directory]")).toBe("/data/ask/thread");
    const filled = JSON.parse(new TextDecoder().decode(withSessionLocation(new TextEncoder().encode("{}"), "/data/ask/thread")));
    expect(filled.location.directory).toBe("/data/ask/thread");
    const kept = JSON.parse(
      new TextDecoder().decode(
        withSessionLocation(new TextEncoder().encode('{"location":{"directory":"/tmp/elsewhere"}}'), "/data/ask/thread"),
      ),
    );
    expect(kept).toEqual({ location: { directory: "/data/ask/thread" } });
    expect(proxyPathAllowed("/api/event")).toBe(true);
    expect(proxyPathAllowed("/event")).toBe(true);
  });

  it("unwraps an OpenCode data envelope so the client can read the session id", () => {
    expect(unwrapOcJson(JSON.stringify({ data: { id: "ses_1", title: "Ask" } }))).toBe(
      JSON.stringify({ id: "ses_1", title: "Ask" }),
    );
    expect(unwrapOcJson(JSON.stringify({ id: "ses_1" }))).toBe(JSON.stringify({ id: "ses_1" }));
    expect(unwrapOcJson("not-json")).toBe("not-json");
  });
});
