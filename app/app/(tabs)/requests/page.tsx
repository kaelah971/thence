import type { Metadata } from "next";
import { Requests } from "@/ui/screens/requests/Requests";

export const metadata: Metadata = { title: "Requests" };

export default function RequestsPage(): React.JSX.Element {
  return <Requests />;
}
