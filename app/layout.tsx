import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "claude-bridge",
  description: "Remote control for a Claude Code session running on your home machine.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-zinc-950 text-zinc-100">{children}</body>
    </html>
  );
}
