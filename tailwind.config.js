/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        "wd-bg": "#0A0A0A",
        "wd-card": "#1A1A1A",
        "wd-border": "#2A2A2A",
        "wd-primary": "#FF2D55",
        "wd-secondary": "#6C63FF",
        "wd-text": "#FFFFFF",
        "wd-text-secondary": "#A0A0A0",
      },
      borderRadius: {
        wd: "16px",
        "wd-pill": "50px",
      },
      boxShadow: {
        wd: "0 8px 32px rgba(0, 0, 0, 0.45)",
      },
    },
  },
};
