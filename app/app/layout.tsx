import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Manrope } from "next/font/google";
import "@/ui/styles/tokens.css";
import { cn } from "@/ui/lib/cn";
import styles from "@/ui/components/shell.module.css";

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage", display: "swap" });
const body = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Thence", template: "%s · Thence" },
  description: "Pay from what you have. They receive what they use.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#101413",
  colorScheme: "dark",
};

export default function ProductLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={cn("th-root", display.variable, body.variable)}>
      <div className={styles.frame}>{children}</div>
    </div>
  );
}
