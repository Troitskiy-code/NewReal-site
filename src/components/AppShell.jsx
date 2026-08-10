"use client";

import { SidebarProvider } from "./SidebarContext";
import Header from "./Header";
import Navbar from "./Navbar";

export default function AppShell({ children }) {
  return (
    <SidebarProvider>
      <Header />
      <Navbar />
      {children}
    </SidebarProvider>
  );
}
