"use client";

import { Suspense } from "react";
import { SidebarProvider } from "./SidebarContext";
import Header from "./Header";
import Navbar from "./Navbar";
import EmailVerificationBanner from "./EmailVerificationBanner";
import { PaymentGoalTracker } from "@/lib/goalTracking";
import CheckoutAttributionCapture from "./CheckoutAttributionCapture";

export default function AppShell({ children }) {
  return (
    <SidebarProvider>
      <Suspense fallback={null}>
        <CheckoutAttributionCapture />
        <PaymentGoalTracker />
      </Suspense>
      <Header />
      <EmailVerificationBanner />
      <Navbar />
      {children}
    </SidebarProvider>
  );
}
