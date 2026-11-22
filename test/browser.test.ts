/**
 * What the CLI will hand to the OS to open.
 *
 * Every URL it opens comes from a service, so only https pages (and http to this machine) are
 * opened, and never through a shell that parses the URL.
 */

import { describe, expect, it } from "vitest";
import { paymentLinkUrl } from "../src/api/billing.js";
import { isWsl, openable, openers } from "../src/browser.js";

describe("openable", () => {
  it("allows https, and http to this machine", () => {
    expect(openable("https://buy.stripe.com/abc")).toBe(true);
    expect(openable("http://localhost:8787/x")).toBe(true);
    expect(openable("http://127.0.0.1:8080")).toBe(true);
  });

  it("refuses every other scheme, and http elsewhere", () => {
    for (const url of ["http://example.test", "file:///etc/passwd", "javascript:alert(1)", "vscode://x", "not a url", undefined]) {
      expect(openable(url)).toBe(false);
    }
  });
});

describe("openers", () => {
  const url = "https://buy.stripe.com/x?a=1&b=it's#frag";

  it("uses open and xdg-open on macOS and Linux", () => {
    expect(openers(url, false, "darwin")).toEqual([{ bin: "open", args: [url] }]);
    expect(openers(url, false, "linux")).toEqual([{ bin: "xdg-open", args: [url] }]);
  });

  it("never goes through cmd on Windows: rundll32 gets the whole URL as one argument", () => {
    expect(openers(url, false, "win32")).toEqual([{ bin: "rundll32", args: ["url.dll,FileProtocolHandler", url] }]);
  });

  it("in WSL tries wslview, then PowerShell with the URL quoted, then rundll32", () => {
    const o = openers(url, true, "linux");
    expect(o.map((x) => x.bin)).toEqual(["wslview", "powershell.exe", "rundll32.exe"]);
    // & stays inside the quoted string, and ' is doubled.
    expect(o[1]?.args.at(-1)).toBe("Start-Process 'https://buy.stripe.com/x?a=1&b=it''s#frag'");
    expect(o[2]?.args).toEqual(["url.dll,FileProtocolHandler", url]);
  });
});

describe("isWsl", () => {
  const none = () => {
    throw new Error("no such file");
  };
  it("is Linux with WSL in the environment or a Microsoft kernel", () => {
    expect(isWsl("linux", { WSL_DISTRO_NAME: "Ubuntu" }, none)).toBe(true);
    expect(isWsl("linux", {}, () => "5.15.153.1-microsoft-standard-WSL2\n")).toBe(true);
    expect(isWsl("linux", {}, () => "6.8.0-45-generic\n")).toBe(false);
    expect(isWsl("linux", {}, none)).toBe(false);
    expect(isWsl("darwin", { WSL_DISTRO_NAME: "Ubuntu" }, none)).toBe(false);
  });
});

describe("paymentLinkUrl", () => {
  it("keeps a hostile link id inside one path segment of buy.stripe.com", () => {
    const url = new URL(paymentLinkUrl("x&calc/../?evil=1#", "org1"));
    expect(url.host).toBe("buy.stripe.com");
    expect(url.pathname.split("/").filter(Boolean)).toHaveLength(1);
    expect(url.searchParams.get("client_reference_id")).toBe("org1");
    expect(url.searchParams.get("evil")).toBeNull();
  });
});
