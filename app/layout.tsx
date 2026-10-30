import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Thence",
  description: "Thence — recipient-first cross-asset payments inside Nimiq Pay.",
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
