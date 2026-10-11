import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RelayForge — Webhook reliability lab",
  description:
    "A live webhook reliability sandbox with signed delivery, durable event state, automatic retries, and complete visibility.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
