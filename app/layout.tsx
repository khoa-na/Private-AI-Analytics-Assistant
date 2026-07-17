import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Private AI Analytics Assistant",
  description: "Grounded natural-language analytics over an active DuckDB dataset.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
