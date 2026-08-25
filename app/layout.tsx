import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "JobApp",
  description: "Job discovery and application tracking platform",
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
