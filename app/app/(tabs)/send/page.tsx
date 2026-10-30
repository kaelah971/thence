import type { Metadata } from "next";
import { Suspense } from "react";
import { SendFlow } from "@/ui/screens/send/SendFlow";

export const metadata: Metadata = { title: "Send money" };

export default function SendPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <SendFlow />
    </Suspense>
  );
}
