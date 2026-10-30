import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DevPreview } from "@/ui/screens/DevPreview";

export const metadata: Metadata = { title: "Development preview", robots: { index: false, follow: false } };

/**
 * Development-only inspection route. It never authenticates anyone and is
 * a 404 in production builds — not an auth bypass.
 */
export default function PreviewPage(): React.JSX.Element {
  if (process.env.NODE_ENV === "production") notFound();
  return <DevPreview />;
}
