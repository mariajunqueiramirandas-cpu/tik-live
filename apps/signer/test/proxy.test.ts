import { describe, expect, test } from "bun:test";
import { describeProxy, oxylabsProvider, oxylabsProxy, parseProxy } from "../src/proxy";

const base = { username: "resi_user", password: "p+w~:x/y", endpoint: "pr.oxylabs.io:7777", sessionMinutes: 40 };

describe("Oxylabs proxy settings", () => {
  test("puts the options in the user name, as Oxylabs reads them", () => {
    expect(oxylabsProxy({ ...base, country: "br" }, "abc123def456")).toEqual({
      server: "http://pr.oxylabs.io:7777",
      username: "customer-resi_user-cc-BR-sessid-abc123def456-sesstime-40",
      password: "p+w~:x/y",
    });
  });

  test("any country when none is chosen", () => {
    expect(oxylabsProxy(base, "s1").username).toBe("customer-resi_user-sessid-s1-sesstime-40");
  });

  test("doesn't add the customer- prefix twice", () => {
    expect(oxylabsProxy({ ...base, username: "customer-resi_user" }, "s1").username).toBe("customer-resi_user-sessid-s1-sesstime-40");
  });

  test("the password goes through untouched: it's passed as a credential, never put in a URL", () => {
    expect(oxylabsProxy(base, "s1").password).toBe("p+w~:x/y");
    expect(oxylabsProxy(base, "s1").server).not.toContain("p+w");
  });

  test("a provider starts a new session, so a new exit address, every time", () => {
    const provider = oxylabsProvider(base);
    const ids = new Set(Array.from({ length: 20 }, () => provider().username!.match(/-sessid-([a-z0-9]+)-/)![1]));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{12}$/);
  });

  test("describes the proxy for logs without its credentials", () => {
    const described = describeProxy(oxylabsProxy(base, "s1"));
    expect(described).toBe("Oxylabs residential via pr.oxylabs.io:7777");
    expect(described).not.toContain("resi_user");
    expect(described).not.toContain("p+w");
    expect(describeProxy({ server: "http://proxy.example.com:3128" })).toBe("proxy proxy.example.com:3128");
  });
});

describe("generic proxy URLs", () => {
  test("split into server and decoded credentials", () => {
    expect(parseProxy("http://user:p%40ss@proxy.example.com:8080")).toEqual({ server: "http://proxy.example.com:8080", username: "user", password: "p@ss" });
    expect(parseProxy("socks5://proxy.example.com:1080")).toEqual({ server: "socks5://proxy.example.com:1080" });
  });
});
