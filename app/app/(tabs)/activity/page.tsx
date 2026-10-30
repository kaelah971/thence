import type { Metadata } from "next";
import { Activity } from "@/ui/screens/activity/Activity";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage(): React.JSX.Element {
  return <Activity />;
}
