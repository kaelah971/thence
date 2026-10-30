import type { Metadata } from "next";
import { NameSetup } from "@/ui/screens/setup/NameSetup";

export const metadata: Metadata = { title: "Your name" };

export default function NameSetupPage(): React.JSX.Element {
  return <NameSetup />;
}
