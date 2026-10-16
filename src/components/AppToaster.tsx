"use client";

import { Toaster } from "react-hot-toast";

export default function AppToaster() {
  return (
    <Toaster
      position="bottom-center"
      containerStyle={{ bottom: "calc(20px + var(--nv-bottom-nav-height, 0px))", zIndex: 9999 }}
      toastOptions={{
        style: {
          background: "#15131d",
          color: "#FFFFFF",
          borderRadius: "12px",
          border: "1px solid #2a2638",
          fontSize: "14px",
          padding: "12px 20px",
          maxWidth: "400px",
        },
      }}
    />
  );
}
