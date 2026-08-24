import { parseTrustProxy, validateProductionTrustProxy } from "./trustProxy";

describe("trust proxy configuration", () => {
  it("parses one trusted proxy hop", () => {
    expect(parseTrustProxy("1")).toBe(1);
  });

  it("rejects a disabled proxy in production", () => {
    expect(() => validateProductionTrustProxy("production", false)).toThrow(
      /TRUST_PROXY must be enabled/
    );
  });

  it("allows a disabled proxy outside production", () => {
    expect(() => validateProductionTrustProxy("test", false)).not.toThrow();
  });
});
