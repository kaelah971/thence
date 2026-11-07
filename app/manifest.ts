import type { MetadataRoute } from "next";

/**
 * Web app manifest: name and branded icons for hosts that list or install
 * the app (Nimiq Pay's app list, Android, iOS home screen). Icons are
 * resized from the official Thence logo; the maskable variant keeps the
 * mark inside the safe zone on the logo's own background colour.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Thence",
    short_name: "Thence",
    description: "Pay in NIM. They receive USDC.",
    start_url: "/app",
    display: "standalone",
    background_color: "#0d1917",
    theme_color: "#0d1917",
    icons: [
      { src: "/brand/thence-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/thence-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/thence-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
