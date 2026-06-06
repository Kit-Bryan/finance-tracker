import type { Metadata } from "next";
import { Syne, IBM_Plex_Mono, DM_Sans } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import Providers from "@/components/Providers";

const syne = Syne({ subsets: ["latin"], variable: "--font-syne", display: "swap" });
const ibmMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-mono",
  display: "swap",
});
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Finance",
  description: "Personal finance tracker",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${syne.variable} ${ibmMono.variable} ${dmSans.variable}`}>
      <body style={{ fontFamily: "var(--font-dm-sans, DM Sans, sans-serif)" }}>
        <Providers>
          <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
            <Sidebar />
            <main style={{ flex: 1, overflowY: "auto", background: "var(--bg)" }}>
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
