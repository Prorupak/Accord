import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Accord",
  description: "Reconcile two inventory CSV exports and export a traceable result.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
