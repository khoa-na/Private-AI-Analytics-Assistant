import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Private AI Analytics Assistant",
  description: "Natural-language analytics over the Olist ecommerce dataset.",
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
