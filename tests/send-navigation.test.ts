import { describe, expect, it } from "vitest";
import { NEW_PAYMENT_HREF, repeatHref, resolveSendNavigation } from "@/ui/lib/send-navigation";

describe("mobile send navigation", () => {
  it("uses an explicit new-intent marker for the New payment entry points", () => {
    expect(NEW_PAYMENT_HREF).toBe("/app/send?intent=new");
    expect(resolveSendNavigation("?intent=new")).toEqual({ kind: "new", explicit: true });
  });

  it("never lets a new-payment tap inherit a stale resume query", () => {
    expect(resolveSendNavigation("?intent=new&resume=old-transfer")).toEqual({ kind: "new", explicit: true });
  });

  it("only resumes when the route explicitly carries a resume id", () => {
    expect(resolveSendNavigation("?resume=old-transfer")).toEqual({ kind: "resume", transferId: "old-transfer" });
    expect(resolveSendNavigation("")).toEqual({ kind: "new", explicit: false });
    expect(resolveSendNavigation("?intent=new", "request")).toEqual({ kind: "new", explicit: false });
  });

  it("repeats a payment with the same recipient, route and amount", () => {
    const href = repeatHref({ routeId: "usdc-arbitrum", address: "0xabc", name: "Ada", amount: "2.50" });
    expect(resolveSendNavigation(href.slice(href.indexOf("?")))).toEqual({
      kind: "repeat",
      routeId: "usdc-arbitrum",
      address: "0xabc",
      name: "Ada",
      amount: "2.50",
    });
  });

  it("refuses a repeat link with a missing route, address or an unparseable amount", () => {
    expect(resolveSendNavigation("?intent=repeat&to=0xabc").kind).toBe("new");
    expect(resolveSendNavigation("?intent=repeat&route=usdc-polygon").kind).toBe("new");
    expect(resolveSendNavigation("?intent=repeat&route=usdc-polygon&to=0xabc&amount=abc")).toMatchObject({ kind: "repeat", amount: null });
    expect(resolveSendNavigation("?intent=repeat&route=usdc-polygon&to=0xabc&amount=0")).toMatchObject({ kind: "repeat", amount: null });
  });
});
