/**
 * Parse browser and OS family + major version from the message request's
 * User-Agent header (docs/design/diagnostics.md "What is captured"). The raw
 * string is never stored. Best-effort family detection for the agent view —
 * not analytics-grade.
 */

type Family = { name: string; major: string | null };

function firstMatch(ua: string, patterns: Array<[RegExp, string]>): Family | null {
  for (const [re, name] of patterns) {
    const match = re.exec(ua);
    if (match) {
      const major = (match[1] ?? "").split(".")[0];
      return { name, major: /^\d+$/u.test(major) ? major : null };
    }
  }
  return null;
}

function parseBrowser(ua: string): Family {
  return (
    firstMatch(ua, [
      [/Edg(?:e|A|iOS)?\/([\d.]+)/u, "Edge"],
      [/OPR\/([\d.]+)/u, "Opera"],
      [/Vivaldi\/([\d.]+)/u, "Vivaldi"],
      [/SamsungBrowser\/([\d.]+)/u, "Samsung Internet"],
      [/YaBrowser\/([\d.]+)/u, "Yandex"],
      [/FxiOS\/([\d.]+)/u, "Firefox"],
      [/CriOS\/([\d.]+)/u, "Chrome"],
      [/Firefox\/([\d.]+)/u, "Firefox"],
      [/Chrome\/([\d.]+)/u, "Chrome"],
      [/Version\/([\d.]+)[\s)].*Safari/u, "Safari"],
      [/\b(?:MSIE\s|Trident\/.*rv:)([\d.]+)/u, "Internet Explorer"],
    ]) ?? { name: "Other", major: null }
  );
}

const WINDOWS_NT: Record<string, string> = {
  "10.0": "10",
  "10": "10",
  "6.3": "8.1",
  "6.2": "8",
  "6.1": "7",
  "6.0": "Vista",
  "5.1": "XP",
  "5.2": "XP",
};

function parseOs(ua: string): Family {
  const android = /Android\s([\d.]+)/u.exec(ua);
  if (android) return { name: "Android", major: android[1].split(".")[0] || null };
  const ios = /(?:iPhone|iPad|iPod).*?OS\s(\d+)[._]/u.exec(ua) ?? /CPU OS\s(\d+)/u.exec(ua);
  if (ios) return { name: "iOS", major: ios[1] || null };
  const windows = /Windows NT\s([\d.]+)/u.exec(ua);
  if (windows) {
    const major = WINDOWS_NT[windows[1]] ?? null;
    return { name: "Windows", major };
  }
  const mac = /Mac OS X\s(\d+)[._]/u.exec(ua) ?? /Macintosh;.*?Mac OS X\s([\d_.]+)/u.exec(ua);
  if (mac) return { name: "macOS", major: mac[1] || null };
  if (/CrOS/u.test(ua)) return { name: "ChromeOS", major: null };
  if (/(Linux|X11|Ubuntu|Fedora)/u.test(ua)) return { name: "Linux", major: null };
  return { name: "Other", major: null };
}

function label({ name, major }: Family): string {
  return major ? `${name} ${major}` : name;
}

export function parseUserAgent(userAgent: string): { browser: string; os: string } {
  const ua = userAgent.slice(0, 500);
  return { browser: label(parseBrowser(ua)), os: label(parseOs(ua)) };
}
