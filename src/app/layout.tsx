import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AFIO Clinical Workflow System",
  description: "Licensed ophthalmology modules with department-scoped reporting workflows"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
