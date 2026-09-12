/**
 * **A browser, described in words nobody but us wrote.**
 *
 * The security letter says which browser a run of failed sign-ins came from (two-factor.md §9). The
 * `User-Agent` header is written by whoever sends the request — during an attack, the attacker — so
 * quoting it would let them write a line of the firm's own security mail ("… to unlock your account
 * call …"). What goes out is a family and a platform picked from the short lists below, or "an
 * unrecognised browser". Nothing from the header itself ever reaches the reader.
 *
 * Order matters: Edge and Opera also say `Chrome/`, Chrome also says `Safari/`, an iPhone also says
 * `Mac OS X`, and Android also says `Linux`. The more specific name is listed first.
 */
const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
  [/curl\//i, "curl"],
  [/python-requests|python-urllib|aiohttp/i, "a Python script"],
];

const PLATFORMS: Array<[RegExp, string]> = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

const UNKNOWN = "an unrecognised browser";

export function describeBrowser(userAgent: string | null | undefined): string {
  if (!userAgent) return UNKNOWN;
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const platform = PLATFORMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  return platform ? `a browser on ${platform}` : UNKNOWN;
}
