"use client";

import { Toaster } from "react-hot-toast";

export default function AppToaster() {
  return (
    <Toaster
      position="bottom-center"
      containerStyle={{ bottom: 20, zIndex: 9999 }}
      toastOptions={{
        style: {
          background: "#1A1A1A",
          color: "#FFFFFF",
          borderRadius: "12px",
          border: "1px solid #2A2A2A",
          fontSize: "14px",
          padding: "12px 20px",
          maxWidth: "400px",
        },
      }}
    />
  );
}
