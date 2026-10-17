import { describe, expect, it } from "bun:test";
import { oxylabsUsername } from "../src";

describe("oxylabsUsername", () => {
  it("puts the country, session and its length in the user name", () => {
    expect(oxylabsUsername({ username: "resi_user", country: "br", sessionId: "abc123", sessionMinutes: 40 })).toBe("customer-resi_user-cc-BR-sessid-abc123-sesstime-40");
  });

  it("leaves the country out when none is chosen, and doesn't repeat the prefix", () => {
    expect(oxylabsUsername({ username: "customer-resi_user", sessionId: "s1", sessionMinutes: 1440 })).toBe("customer-resi_user-sessid-s1-sesstime-1440");
  });
});
