import type { Metadata } from "next";
import { Onboarding } from "@/ui/screens/onboarding/Onboarding";

export const metadata: Metadata = { title: "Welcome" };

export default function WelcomePage(): React.JSX.Element {
  return <Onboarding />;
}
