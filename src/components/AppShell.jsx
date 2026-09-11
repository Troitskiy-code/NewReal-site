"use client";

import { SidebarProvider } from "./SidebarContext";
import Header from "./Header";
import Navbar from "./Navbar";
import EmailVerificationBanner from "./EmailVerificationBanner";

export default function AppShell({ children }) {
  return (
    <SidebarProvider>
      <Header />
      <EmailVerificationBanner />
      <Navbar />
      {children}
    </SidebarProvider>
  );
}
