import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FilesDude File Explorer",
  description: "A secure, self-hosted file explorer for your server.",
  icons: {
    icon: "/favicon.svg",
  },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
