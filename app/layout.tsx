import type { Metadata, Viewport } from "next";
import "./globals.css";
import PasswordGate from "./components/PasswordGate";

export const metadata: Metadata = {
  title: "Realtime Whisper",
  description: "Realtime speech-to-text in your browser, powered by OpenAI gpt-realtime-whisper.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0d10",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PasswordGate>{children}</PasswordGate>
      </body>
    </html>
  );
}
