/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', '"Fira Code"', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.625rem', '0.875rem'],
      },
      colors: {
        sidebar: {
          DEFAULT: '#09090b',
          foreground: '#fafafa',
          muted: '#a1a1aa',
          accent: '#27272a',
          border: '#27272a',
          ring: '#3f3f46',
        },
      },
    },
  },
  plugins: [],
}
