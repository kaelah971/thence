import type { Metadata } from "next";
import { Home } from "@/ui/screens/home/Home";

export const metadata: Metadata = { title: "Home" };

export default function HomePage(): React.JSX.Element {
  return <Home />;
}
