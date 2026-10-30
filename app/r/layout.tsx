import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Manrope } from "next/font/google";
import "@/ui/styles/tokens.css";
import { cn } from "@/ui/lib/cn";
import styles from "@/ui/components/shell.module.css";

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage", display: "swap" });
const body = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });

/** Public payment-request links: same Thence shell, no session required, never indexed. */
export const metadata: Metadata = {
  title: { default: "Payment request · Thence", template: "%s · Thence" },
  description: "Someone asked to be paid with Thence.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#101413",
  colorScheme: "dark",
};

export default function PublicRequestLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={cn("th-root", display.variable, body.variable)}>
      <div className={styles.frame}>{children}</div>
    </div>
  );
}
