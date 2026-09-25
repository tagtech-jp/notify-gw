import { describe, expect, it } from "vitest";
import { extractKey, isAuthorized, authenticate } from "../src/lib/auth";

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

describe("authenticate", () => {
  const env = { RUN_KEY: "main-key", RUN_KEY_MT5: "mt5-key" };

  it("returns 'run_key' when the key matches RUN_KEY", () => {
    expect(authenticate("main-key", env)).toBe("run_key");
  });

  it("returns 'run_key_mt5' when the key matches RUN_KEY_MT5", () => {
    expect(authenticate("mt5-key", env)).toBe("run_key_mt5");
  });

  it("returns null for a wrong key", () => {
    expect(authenticate("wrong", env)).toBeNull();
  });

  it("returns null when RUN_KEY_MT5 is undefined, regardless of the provided value", () => {
    const noMt5 = { RUN_KEY: "main-key" };
    expect(authenticate("", noMt5)).toBeNull();
    expect(authenticate("mt5-key", noMt5)).toBeNull();
    expect(authenticate("anything", noMt5)).toBeNull();
  });

  it("returns null when RUN_KEY_MT5 is an empty string, regardless of the provided value", () => {
    const emptyMt5 = { RUN_KEY: "main-key", RUN_KEY_MT5: "" };
    expect(authenticate("", emptyMt5)).toBeNull();
    expect(authenticate("mt5-key", emptyMt5)).toBeNull();
    expect(authenticate("anything", emptyMt5)).toBeNull();
  });

  it("still authenticates RUN_KEY normally when RUN_KEY_MT5 is unset", () => {
    expect(authenticate("main-key", { RUN_KEY: "main-key" })).toBe("run_key");
  });
});
