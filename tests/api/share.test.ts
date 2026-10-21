/**
 * Sharing falls back sensibly where the phone's share menu is missing
 * (most laptops), and closing the menu is not treated as a failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { share } from "@/lib/share";

const nav = navigator as unknown as Record<string, unknown>;
const saved = { share: nav.share, canShare: nav.canShare, clipboard: nav.clipboard };

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    Object.defineProperty(navigator, k, { value: v, configurable: true, writable: true });
  }
});

function setNav(k: string, v: unknown) {
  Object.defineProperty(navigator, k, { value: v, configurable: true, writable: true });
}

describe("share", () => {
  it("copies the text when there is no share menu and no image", async () => {
    const writeText = vi.fn(async () => {});
    setNav("share", undefined);
    setNav("clipboard", { writeText });
    expect(await share({ text: "hello https://airgyaan.in" })).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("hello https://airgyaan.in");
  });

  it("sends the image and text together when files can be shared", async () => {
    const shareFn = vi.fn(async () => {});
    setNav("share", shareFn);
    setNav("canShare", () => true);
    const out = await share({ text: "t", image: new Blob(["x"], { type: "image/png" }) });
    expect(out).toBe("shared");
    const arg = (shareFn.mock.calls[0] as unknown[])[0] as { files: File[]; text: string };
    expect(arg.files[0].type).toBe("image/png");
    expect(arg.text).toBe("t");
  });

  it("treats closing the menu as cancelled, not as an error", async () => {
    const abort = Object.assign(new Error("closed"), { name: "AbortError" });
    setNav("share", vi.fn(async () => Promise.reject(abort)));
    expect(await share({ text: "t" })).toBe("cancelled");
  });
});
