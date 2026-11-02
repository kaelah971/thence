import { describe, expect, it } from "vitest";
import { NEW_PAYMENT_HREF, resolveSendNavigation } from "@/ui/lib/send-navigation";

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
});
