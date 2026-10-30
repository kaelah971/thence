import type { Metadata } from "next";
import { Reconnect } from "@/ui/screens/setup/Reconnect";

export const metadata: Metadata = { title: "Welcome back" };

export default function ReconnectPage(): React.JSX.Element {
  return <Reconnect />;
}
