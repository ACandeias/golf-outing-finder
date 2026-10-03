import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { request } from "undici";
import { installNetworkBlock, NetworkBlockedError, type NetworkBlock } from "./block.ts";

let block: NetworkBlock | null = null;
afterEach(() => {
  block?.restore();
  block = null;
});

function causeOf(err: unknown): unknown {
  return err instanceof Error && "cause" in err ? err.cause : err;
}

describe("dry-run network block", () => {
  it("refuses global fetch before any connection is made", async () => {
    block = installNetworkBlock();
    const err = await fetch("https://api.anthropic.com/v1/messages").catch((e: unknown) => e);
    expect(causeOf(err)).toBeInstanceOf(NetworkBlockedError);
    expect(block.attempts).toEqual(["https://api.anthropic.com/v1/messages"]);
  });

  it("refuses undici.request", async () => {
    block = installNetworkBlock();
    await expect(request("https://api.dataforseo.com/v3/serp")).rejects.toBeInstanceOf(
      NetworkBlockedError,
    );
    expect(block.attempts).toHaveLength(1);
  });

  it("refuses node:http, node:https and raw TCP sockets", () => {
    block = installNetworkBlock();
    expect(() => http.get("http://example.org/")).toThrow(NetworkBlockedError);
    expect(() => https.get("https://example.org/")).toThrow(NetworkBlockedError);
    expect(() => net.connect({ host: "127.0.0.1", port: 9 })).toThrow(NetworkBlockedError);
    expect(() => net.connect(9, "10.0.0.1")).toThrow(NetworkBlockedError);
    expect(block.attempts).toEqual([
      "example.org:80",
      "example.org:443",
      "127.0.0.1:9",
      "10.0.0.1:9",
    ]);
  });

  it("is idempotent and restores the previous state", async () => {
    block = installNetworkBlock();
    expect(installNetworkBlock()).toBe(block);
    block.restore();
    block = null;
    // After restore a connect attempt reaches the OS again (port 9 on localhost is closed).
    const result = await new Promise<string>((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port: 9 });
      s.on("error", () => resolve("os-error"));
      s.on("connect", () => {
        s.destroy();
        resolve("connected");
      });
    });
    expect(["os-error", "connected"]).toContain(result);
  });
});
