import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Davis & Kwong LLP · Toolkit",
  description: "Internal tools for Davis & Kwong LLP",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
