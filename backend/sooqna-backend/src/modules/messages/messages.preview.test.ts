import { createSafeMessagePreview } from "./messages.service";

describe("createSafeMessagePreview", () => {
  it("normalizes Unicode whitespace and redacts email and secret assignments", () => {
    expect(
      createSafeMessagePreview("  hello\u00a0\n alice@example.com\tpassword = hunter2 token=abc123 world  ")
    ).toBe("hello [redacted] [redacted] [redacted] world");
  });

  it("redacts colon, JSON, bare secret forms, and Unicode email local parts", () => {
    const preview = createSafeMessagePreview(
      'password: hunter2 token abc123 {"password":"json-secret"} علي@example.com'
    );
    expect(preview).toBe("[redacted] [redacted] {[redacted]} [redacted]");
    expect(preview).not.toMatch(/hunter2|abc123|json-secret|example\.com/u);
  });

  it("caps previews at 120 Unicode code points without splitting surrogate pairs", () => {
    const preview = createSafeMessagePreview(`😀${"x".repeat(200)}`);
    expect(Array.from(preview)).toHaveLength(120);
    expect(preview.startsWith("😀")).toBe(true);
    expect(preview).not.toContain("�");
  });
});
