import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dev 端口 5173，proxy /api/* → 后端（API_PORT 由 backend spawn 传入，缺省 3000）
// 构建产物 base=/dashboard/ 便于 Express 静态挂载
const apiPort = process.env.API_PORT || "3000";

export default defineConfig({
  base: "/dashboard/",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
