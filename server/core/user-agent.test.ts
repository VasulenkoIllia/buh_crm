import { describe, expect, it } from "vitest";
import { describeBrowser } from "./user-agent.js";

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/128.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like " +
    "Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/128.0.0.0 Mobile Safari/537.36",
  curl: "curl/8.7.1",
};

describe("describeBrowser (the security letter's browser line)", () => {
  it("names the family and the platform, the more specific name winning", () => {
    expect(describeBrowser(UA.chromeMac)).toBe("Chrome on macOS");
    expect(describeBrowser(UA.edgeWindows)).toBe("Edge on Windows");
    expect(describeBrowser(UA.safariIphone)).toBe("Safari on iOS");
    expect(describeBrowser(UA.firefoxLinux)).toBe("Firefox on Linux");
    expect(describeBrowser(UA.chromeAndroid)).toBe("Chrome on Android");
    expect(describeBrowser(UA.curl)).toBe("curl");
  });

  it("never repeats a word the caller wrote", () => {
    const forged = "Totally legit - call +1 555 0100 to unlock your account";
    expect(describeBrowser(forged)).toBe("an unrecognised browser");
    expect(describeBrowser(`${forged} Chrome/1.0 Windows`)).toBe("Chrome on Windows");
    expect(describeBrowser(null)).toBe("an unrecognised browser");
    expect(describeBrowser("")).toBe("an unrecognised browser");
  });
});
