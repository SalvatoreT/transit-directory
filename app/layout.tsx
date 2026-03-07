import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Transit Directory",
  description: "Real-time transit information for agencies.",
  icons: { icon: "/favicon.svg" },
  alternates: { types: { "application/xml": "/sitemap.xml" } },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div id="content-wrapper">{children}</div>
        <footer>
          Made with &#10084;&#65039; in Oakland, CA{" "}
          <span className="separator">|</span>{" "}
          <a href="https://bsky.app/profile/sal.dev">@sal.dev</a>{" "}
          <span className="separator">|</span>{" "}
          <a href="https://github.com/SalvatoreT/transit-directory">Source</a>
        </footer>
      </body>
    </html>
  );
}
