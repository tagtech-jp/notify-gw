import { describe, expect, it } from "vitest";
import { extractKey, isAuthorized } from "../src/lib/auth";

function req(url: string, headers?: Record<string, string>): Request {
  return new Request(url, { headers });
}

describe("extractKey", () => {
  it("prefers the X-Run-Key header over the query string", () => {
    const r = req("https://example.com/event?key=fromquery", { "x-run-key": "fromheader" });
    expect(extractKey(r)).toBe("fromheader");
  });

  it("falls back to ?key= when no header is present", () => {
    const r = req("https://example.com/event?key=fromquery");
    expect(extractKey(r)).toBe("fromquery");
  });

  it("returns empty string when neither is present", () => {
    const r = req("https://example.com/event");
    expect(extractKey(r)).toBe("");
  });

  it("an empty header value does NOT fall back to the query string", () => {
    const r = req("https://example.com/event?key=fromquery", { "x-run-key": "" });
    expect(extractKey(r)).toBe("");
  });
});

describe("isAuthorized", () => {
  it("accepts a matching key", () => {
    expect(isAuthorized("secret123", "secret123")).toBe(true);
  });

  it("rejects a mismatched key", () => {
    expect(isAuthorized("wrong", "secret123")).toBe(false);
  });

  it("rejects when expected is undefined (fail-closed)", () => {
    expect(isAuthorized("anything", undefined)).toBe(false);
  });

  it("rejects when expected is empty string", () => {
    expect(isAuthorized("anything", "")).toBe(false);
  });

  it("rejects when provided is empty string", () => {
    expect(isAuthorized("", "secret123")).toBe(false);
  });

  it("rejects different-length strings without throwing", () => {
    expect(isAuthorized("short", "muchlongersecret")).toBe(false);
  });
});
