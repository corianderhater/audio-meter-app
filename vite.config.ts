import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";

// `base` is the URL prefix the production build is served from. GitHub Pages
// publishes at https://<user>.github.io/<repo>/, so we need /<repo>/ in
// production. Dev server stays at "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/audio-meter-app/" : "/",
  plugins: [
    react(),
    basicSsl(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-192.png", "icon-512.png"],
      manifest: {
        name: "Audio Meter",
        short_name: "AudioMeter",
        description:
          "Real-time spectrum analyzer and SPL meter for live sound professionals.",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        display: "standalone",
        orientation: "any",
        start_url: "./",
        scope: "./",
        icons: [
          {
            src: "icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
  },
}));
