import type { Metadata } from "next";
import { Recipients } from "@/ui/screens/recipients/Recipients";

export const metadata: Metadata = { title: "Recipients" };

export default function RecipientsPage(): React.JSX.Element {
  return <Recipients />;
}
