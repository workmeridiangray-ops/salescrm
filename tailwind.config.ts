import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: { canvas: "#F7F8FA", surface: "#FFFFFF", ink: "#17212F", muted: "#526174", line: "#D9DFE7", accent: "#244B78" },
      borderRadius: { DEFAULT: "8px", lg: "12px" },
      fontFamily: { sans: ["Inter", "system-ui", "sans-serif"] },
    },
  },
  plugins: [],
} satisfies Config;
